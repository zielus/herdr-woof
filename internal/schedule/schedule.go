// Package schedule parses cron-style schedule expressions and computes their
// occurrences in an IANA time zone.
//
// Cron expressions are evaluated on the zone's wall clock. Each matching civil
// time C (year, month, day, hour, minute; seconds are always 0) maps to the
// earliest instant whose wall clock is at or after C:
//
//   - C exists once: that instant.
//   - C is repeated by a backward transition: the first pass only, so a
//     repeated wall time fires once.
//   - C falls in a forward gap: the transition instant ending the gap. For
//     example America/New_York 2026-03-08 02:30 maps to 03:00 EDT (07:00Z).
//
// Several civil times may map to the same instant; that instant is reported
// once because Next only returns instants strictly after its argument.
//
// "@every D" schedules are pure elapsed time from an anchor and ignore DST.
package schedule

import (
	"errors"
	"fmt"
	"math"
	"math/bits"
	"os"
	"strings"
	"time"
	"unicode"

	_ "time/tzdata"
)

// ErrNever reports that a cron expression has no occurrence within five years.
var ErrNever = errors.New("schedule: no occurrence within 5 years")

const searchYears = 5

// Expr is a parsed schedule expression bound to an IANA zone.
type Expr struct {
	text  string
	zone  string
	loc   *time.Location
	every time.Duration
	spec  spec
}

// Parse parses expr in the given zone.
//
// Accepted forms:
//   - five cron fields "minute hour day-of-month month day-of-week";
//   - @yearly, @annually, @monthly, @weekly, @daily, @midnight, @hourly
//     (case-insensitive);
//   - "@every <duration>" with a Go duration of at least one second;
//   - any of the above prefixed by "TZ=Zone " or "CRON_TZ=Zone ".
//
// Field ranges: minute 0-59, hour 0-23, day-of-month 1-31, month 1-12 or
// jan-dec, day-of-week 0-7 or sun-sat with 0 and 7 both Sunday. Names are
// case-insensitive and may be used in ranges. Each field is a comma list of
// "*", "?", "N", "N-M", optionally followed by "/step"; "N/step" means N
// through the field maximum. For day-of-week, "*" and "N/step" stop at 6, so 7
// only appears when written explicitly.
//
// Day matching follows robfig/cron: if day-of-month or day-of-week is
// unrestricted ("*" or "?", including "*/1") a day must match both fields;
// otherwise it must match either. "0 0 */2 * MON" fires on odd days and on
// Mondays.
//
// timezone selects the zone explicitly; when empty the prefix zone is used,
// and without a prefix LocalZone(). A prefix that differs from timezone is an
// error, as is the zone name "Local".
func Parse(expr, timezone string) (*Expr, error) {
	rest := strings.TrimSpace(expr)
	var prefixZone string
	for _, p := range []string{"TZ=", "CRON_TZ="} {
		if !strings.HasPrefix(rest, p) {
			continue
		}
		i := strings.IndexFunc(rest, unicode.IsSpace)
		if i < 0 {
			return nil, fmt.Errorf("schedule: %s prefix must be followed by an expression", strings.TrimSuffix(p, "="))
		}
		prefixZone = rest[len(p):i]
		if prefixZone == "" {
			return nil, fmt.Errorf("schedule: empty %s zone", strings.TrimSuffix(p, "="))
		}
		rest = strings.TrimSpace(rest[i:])
		break
	}
	timezone = strings.TrimSpace(timezone)
	if prefixZone != "" && timezone != "" && prefixZone != timezone {
		return nil, fmt.Errorf("schedule: expression zone %q conflicts with zone %q", prefixZone, timezone)
	}
	zone := timezone
	if zone == "" {
		zone = prefixZone
	}
	if zone == "" {
		zone = LocalZone()
	}
	if zone == "Local" {
		return nil, errors.New(`schedule: zone "Local" is not an IANA zone name`)
	}
	loc, err := time.LoadLocation(zone)
	if err != nil {
		return nil, fmt.Errorf("schedule: unknown zone %q: %w", zone, err)
	}

	x := &Expr{zone: zone, loc: loc}
	fields := strings.Fields(rest)
	if len(fields) == 0 {
		return nil, errors.New("schedule: empty expression")
	}
	if strings.HasPrefix(fields[0], "@") {
		name := strings.ToLower(fields[0])
		if name == "@every" {
			if len(fields) != 2 {
				return nil, errors.New("schedule: @every requires exactly one duration")
			}
			d, err := time.ParseDuration(fields[1])
			if err != nil {
				return nil, fmt.Errorf("schedule: %w", err)
			}
			if d < time.Second {
				return nil, fmt.Errorf("schedule: @every duration %s is below 1s", d)
			}
			x.every = d
			x.text = "@every " + d.String()
			return x, nil
		}
		s, ok := descriptors[name]
		if !ok {
			return nil, fmt.Errorf("schedule: unknown descriptor %q", fields[0])
		}
		if len(fields) != 1 {
			return nil, fmt.Errorf("schedule: unexpected text after %s", name)
		}
		x.spec = s
		x.text = name
		return x, nil
	}
	if x.spec, err = parseFields(fields); err != nil {
		return nil, fmt.Errorf("schedule: %w", err)
	}
	x.text = strings.Join(fields, " ")
	return x, nil
}

// Timezone returns the resolved IANA zone name.
func (x *Expr) Timezone() string { return x.zone }

// Location returns the resolved zone.
func (x *Expr) Location() *time.Location { return x.loc }

// Every returns the interval of an @every expression and 0 otherwise.
func (x *Expr) Every() time.Duration { return x.every }

// String returns the canonical expression without a zone prefix.
func (x *Expr) String() string { return x.text }

// Next returns the first occurrence strictly after after. For @every the
// occurrences are anchor + n*Every() for n >= 0 and anchor must be set; for
// cron expressions anchor is ignored and ErrNever is returned when nothing
// occurs within five years after after.
func (x *Expr) Next(after, anchor time.Time) (time.Time, error) {
	if x.every > 0 {
		return x.nextEvery(after, anchor)
	}
	limit := after.AddDate(searchYears, 0, 0)
	w := after.In(x.loc)
	c := civil{w.Year(), int(w.Month()), w.Day(), w.Hour(), w.Minute()}
	maxYear := w.Year() + searchYears + 1
	for {
		var ok bool
		if c, ok = x.spec.next(c, maxYear); !ok {
			return time.Time{}, ErrNever
		}
		t := resolve(c, x.loc)
		if t.After(limit) {
			return time.Time{}, ErrNever
		}
		if t.After(after) {
			return t, nil
		}
		c = c.addMinute()
	}
}

// Due summarizes occurrences t with from <= t <= now. At most limit
// occurrences are counted; when more exist Capped is set, Count equals limit
// and Latest is still the greatest occurrence not after now. limit must be
// positive.
type Due struct {
	Count         int64
	First, Latest time.Time
	Capped        bool
}

// Due returns the occurrences between from and now inclusive.
func (x *Expr) Due(from, now, anchor time.Time, limit int) (Due, error) {
	if limit < 1 {
		return Due{}, errors.New("schedule: limit must be positive")
	}
	if x.every > 0 {
		return x.dueEvery(from, now, anchor, int64(limit))
	}
	var due Due
	if from.After(now) {
		return due, nil
	}
	t, err := x.Next(from.Add(-time.Nanosecond), anchor)
	for err == nil && !t.After(now) {
		if due.Count == int64(limit) {
			due.Capped = true
			break
		}
		if due.Count == 0 {
			due.First = t
		}
		due.Count++
		due.Latest = t
		t, err = x.Next(t, anchor)
	}
	if err != nil && !errors.Is(err, ErrNever) {
		return Due{}, err
	}
	if due.Capped {
		due.Latest = x.latest(due.Latest, now)
	}
	return due, nil
}

// latest returns the greatest occurrence not after now, given an occurrence
// lo whose successor is also not after now. Occurrences fall on whole
// seconds and "Next(s) > now" is monotone in s, so a binary search over
// seconds in (lo, now] finds it.
func (x *Expr) latest(lo, now time.Time) time.Time {
	loS, hiS := lo.Unix(), now.Unix()
	for hiS-loS > 1 {
		mid := loS + (hiS-loS)/2
		t, err := x.Next(time.Unix(mid, 0), time.Time{})
		if err == nil && !t.After(now) {
			loS = mid
		} else {
			hiS = mid
		}
	}
	t, _ := x.Next(time.Unix(loS, 0), time.Time{})
	return t
}

var errAnchor = errors.New("schedule: @every requires a non-zero anchor")

func span(a, b time.Time) (time.Duration, error) {
	d := b.Sub(a)
	if d == math.MaxInt64 || d == math.MinInt64 {
		return 0, errors.New("schedule: time span out of range")
	}
	return d, nil
}

func (x *Expr) nextEvery(after, anchor time.Time) (time.Time, error) {
	if anchor.IsZero() {
		return time.Time{}, errAnchor
	}
	if after.Before(anchor) {
		return anchor.In(x.loc), nil
	}
	d, err := span(anchor, after)
	if err != nil {
		return time.Time{}, err
	}
	n := d/x.every + 1
	if n > math.MaxInt64/x.every {
		return time.Time{}, errors.New("schedule: time span out of range")
	}
	return anchor.Add(n * x.every).In(x.loc), nil
}

func (x *Expr) dueEvery(from, now, anchor time.Time, limit int64) (Due, error) {
	if anchor.IsZero() {
		return Due{}, errAnchor
	}
	if from.After(now) || now.Before(anchor) {
		return Due{}, nil
	}
	if from.Before(anchor) {
		from = anchor
	}
	lo, err := span(anchor, from)
	if err != nil {
		return Due{}, err
	}
	hi, err := span(anchor, now)
	if err != nil {
		return Due{}, err
	}
	first := lo / x.every
	if lo%x.every != 0 {
		first++
	}
	last := hi / x.every
	if last < first {
		return Due{}, nil
	}
	due := Due{
		Count:  int64(last - first + 1),
		First:  anchor.Add(first * x.every).In(x.loc),
		Latest: anchor.Add(last * x.every).In(x.loc),
	}
	if due.Count > limit {
		due.Count, due.Capped = limit, true
	}
	return due, nil
}

// LocalZone returns the host's IANA zone name: $TZ when it names a loadable
// zone (a leading ':' and any path up to "zoneinfo/" are stripped; "" and
// "Local" are ignored), else the zone named by the /etc/localtime symlink,
// else "UTC".
func LocalZone() string {
	if tz, ok := os.LookupEnv("TZ"); ok {
		if name := zoneName(strings.TrimPrefix(tz, ":")); name != "" {
			return name
		}
	}
	if target, err := os.Readlink("/etc/localtime"); err == nil {
		if i := strings.LastIndex(target, "zoneinfo/"); i >= 0 {
			if name := zoneName(target[i:]); name != "" {
				return name
			}
		}
	}
	// Debian-style hosts may copy /etc/localtime and name the zone here.
	if data, err := os.ReadFile("/etc/timezone"); err == nil {
		if name := zoneName(strings.TrimSpace(string(data))); name != "" {
			return name
		}
	}
	return "UTC"
}

func zoneName(s string) string {
	if i := strings.LastIndex(s, "zoneinfo/"); i >= 0 {
		s = s[i+len("zoneinfo/"):]
	}
	if s == "" || s == "Local" {
		return ""
	}
	if _, err := time.LoadLocation(s); err != nil {
		return ""
	}
	return s
}

// FormatLocal renders UTC Unix milliseconds as RFC 3339 in loc, or "" for 0.
func FormatLocal(ms int64, loc *time.Location) string {
	if ms == 0 {
		return ""
	}
	if loc == nil {
		loc = time.UTC
	}
	return time.UnixMilli(ms).In(loc).Format(time.RFC3339)
}

// civil is a wall-clock minute without a zone. Day and hour may temporarily
// overflow; spec.next normalizes them.
type civil struct {
	y, mo, d, h, mi int
}

func (c civil) addMinute() civil {
	c.mi++
	if c.mi > 59 {
		c.mi = 0
		c.h++
		if c.h > 23 {
			c.h = 0
			c.d++
		}
	}
	return c
}

func (c civil) unix() int64 {
	return time.Date(c.y, time.Month(c.mo), c.d, c.h, c.mi, 0, 0, time.UTC).Unix()
}

// next returns the smallest civil time at or after c matching s, searching
// no further than the end of maxYear. It skips whole months, days and hours
// that cannot match.
func (s *spec) next(c civil, maxYear int) (civil, bool) {
	for c.y <= maxYear {
		if s.month&(1<<c.mo) == 0 {
			m, ok := nextBit(s.month, c.mo+1, 12)
			if !ok {
				c = civil{c.y + 1, 1, 1, 0, 0}
				continue
			}
			c = civil{c.y, m, 1, 0, 0}
		}
		if c.d > daysIn(c.y, c.mo) {
			c = civil{c.y, c.mo + 1, 1, 0, 0}
			if c.mo > 12 {
				c = civil{c.y + 1, 1, 1, 0, 0}
			}
			continue
		}
		if !s.dayMatches(c.y, c.mo, c.d) {
			c = civil{c.y, c.mo, c.d + 1, 0, 0}
			continue
		}
		h, ok := nextBit(s.hour, c.h, 23)
		if !ok {
			c = civil{c.y, c.mo, c.d + 1, 0, 0}
			continue
		}
		if h != c.h {
			c.h, c.mi = h, 0
		}
		mi, ok := nextBit(s.minute, c.mi, 59)
		if !ok {
			c = civil{c.y, c.mo, c.d, c.h, 59}.addMinute()
			continue
		}
		c.mi = mi
		return c, true
	}
	return civil{}, false
}

func (s *spec) dayMatches(y, mo, d int) bool {
	wd := time.Date(y, time.Month(mo), d, 0, 0, 0, 0, time.UTC).Weekday()
	domMatch := s.dom&(1<<d) != 0
	dowMatch := s.dow&(1<<wd) != 0
	if s.dom&starBit != 0 || s.dow&starBit != 0 {
		return domMatch && dowMatch
	}
	return domMatch || dowMatch
}

// nextBit returns the lowest set bit of mask in [from, max].
func nextBit(mask uint64, from, max int) (int, bool) {
	m := mask &^ starBit & (math.MaxUint64 << from)
	if m == 0 {
		return 0, false
	}
	b := bits.TrailingZeros64(m)
	return b, b <= max
}

func daysIn(y, mo int) int {
	return time.Date(y, time.Month(mo)+1, 0, 0, 0, 0, 0, time.UTC).Day()
}

// resolve maps a civil time to the earliest instant whose wall clock in loc
// is at or after it. Within one zone period the wall clock is instant+offset,
// so the answer lies in the first period whose end has a wall clock past c.
func resolve(c civil, loc *time.Location) time.Time {
	u := c.unix()
	i := u - 2*86400
	for range 64 {
		t := time.Unix(i, 0).In(loc)
		_, off := t.Zone()
		_, end := t.ZoneBounds()
		if end.IsZero() || end.Unix()+int64(off) > u {
			return time.Unix(max(i, u-int64(off)), 0).In(loc)
		}
		i = end.Unix()
	}
	return time.Date(c.y, time.Month(c.mo), c.d, c.h, c.mi, 0, 0, loc)
}
