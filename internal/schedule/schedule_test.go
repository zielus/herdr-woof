package schedule

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func mustParse(t *testing.T, expr, zone string) *Expr {
	t.Helper()
	x, err := Parse(expr, zone)
	if err != nil {
		t.Fatalf("Parse(%q, %q): %v", expr, zone, err)
	}
	return x
}

func ts(t *testing.T, s string) time.Time {
	t.Helper()
	v, err := time.Parse(time.RFC3339, s)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func TestParse(t *testing.T) {
	t.Setenv("TZ", "Europe/Warsaw")
	tests := []struct {
		expr, zone string
		ok         bool
		wantZone   string
		wantString string
	}{
		{"0 9 * * *", "UTC", true, "UTC", "0 9 * * *"},
		{"  0   9 * *    * ", "UTC", true, "UTC", "0 9 * * *"},
		{"0 9 * * *", "", true, "Europe/Warsaw", "0 9 * * *"},
		{"CRON_TZ=Europe/Warsaw 0 9 * * *", "", true, "Europe/Warsaw", "0 9 * * *"},
		{"TZ=America/New_York 0 9 * * *", "", true, "America/New_York", "0 9 * * *"},
		{"TZ=UTC\t0 9 * * *", "UTC", true, "UTC", "0 9 * * *"},
		{"TZ=UTC 0 9 * * *", "Europe/Warsaw", false, "", ""},
		{"TZ=UTC", "", false, "", ""},
		{"CRON_TZ=UTC   ", "", false, "", ""},
		{"TZ= 0 9 * * *", "", false, "", ""},
		{"0 9 * * *", "Local", false, "", ""},
		{"TZ=Local 0 9 * * *", "", false, "", ""},
		{"0 9 * * *", "Mars/Olympus", false, "", ""},
		{"0 0 30 2 *", "UTC", true, "UTC", "0 0 30 2 *"},
		{"0 0 * * 7", "UTC", true, "UTC", "0 0 * * 7"},
		{"0 9 * * MON-FRI", "UTC", true, "UTC", "0 9 * * MON-FRI"},
		{"0 9 1 jan,Jul sun", "UTC", true, "UTC", "0 9 1 jan,Jul sun"},
		{"0 0 */2 * MON", "UTC", true, "UTC", "0 0 */2 * MON"},
		{"0 0 ? * ?", "UTC", true, "UTC", "0 0 ? * ?"},
		{"5/15 * * * *", "UTC", true, "UTC", "5/15 * * * *"},
		{"0 0 * * 5-7", "UTC", true, "UTC", "0 0 * * 5-7"},
		{"@every 500ms", "UTC", false, "", ""},
		{"@every 90m", "UTC", true, "UTC", "@every 1h30m0s"},
		{"@every 1s", "UTC", true, "UTC", "@every 1s"},
		{"@every", "UTC", false, "", ""},
		{"@every 1h 2h", "UTC", false, "", ""},
		{"@every -1h", "UTC", false, "", ""},
		{"@DAILY", "UTC", true, "UTC", "@daily"},
		{"@Hourly", "UTC", true, "UTC", "@hourly"},
		{"@yearly", "UTC", true, "UTC", "@yearly"},
		{"@annually", "UTC", true, "UTC", "@annually"},
		{"@monthly", "UTC", true, "UTC", "@monthly"},
		{"@weekly", "UTC", true, "UTC", "@weekly"},
		{"@midnight", "UTC", true, "UTC", "@midnight"},
		{"@daily now", "UTC", false, "", ""},
		{"@fortnightly", "UTC", false, "", ""},
		{"", "UTC", false, "", ""},
		{"   ", "UTC", false, "", ""},
		{"0 0 0 * * *", "UTC", false, "", ""},
		{"0 0 * *", "UTC", false, "", ""},
		{"60 * * * *", "UTC", false, "", ""},
		{"* 24 * * *", "UTC", false, "", ""},
		{"* * 0 * *", "UTC", false, "", ""},
		{"* * 32 * *", "UTC", false, "", ""},
		{"* * * 13 *", "UTC", false, "", ""},
		{"* * * * 8", "UTC", false, "", ""},
		{"*/0 * * * *", "UTC", false, "", ""},
		{"5-1 * * * *", "UTC", false, "", ""},
		{"1,,2 * * * *", "UTC", false, "", ""},
		{",5 * * * *", "UTC", false, "", ""},
		{"*-5 * * * *", "UTC", false, "", ""},
		{"+5 * * * *", "UTC", false, "", ""},
		{"-5 * * * *", "UTC", false, "", ""},
		{"1-2-3 * * * *", "UTC", false, "", ""},
		{"*/2/3 * * * *", "UTC", false, "", ""},
		{"0 0 * * 7/2", "UTC", false, "", ""},
		{"0 0 * * mon-sun", "UTC", false, "", ""},
		{"0 0 * jan-mon *", "UTC", false, "", ""},
		{"x * * * *", "UTC", false, "", ""},
		{"99999999999999999999 * * * *", "UTC", false, "", ""},
	}
	for _, tt := range tests {
		x, err := Parse(tt.expr, tt.zone)
		if !tt.ok {
			if err == nil {
				t.Errorf("Parse(%q, %q) succeeded, want error", tt.expr, tt.zone)
			}
			continue
		}
		if err != nil {
			t.Errorf("Parse(%q, %q): %v", tt.expr, tt.zone, err)
			continue
		}
		if x.Timezone() != tt.wantZone || x.Location().String() != tt.wantZone {
			t.Errorf("Parse(%q, %q) zone = %q/%q, want %q", tt.expr, tt.zone, x.Timezone(), x.Location(), tt.wantZone)
		}
		if x.String() != tt.wantString {
			t.Errorf("Parse(%q, %q).String() = %q, want %q", tt.expr, tt.zone, x.String(), tt.wantString)
		}
	}
	if d := mustParse(t, "@every 90m", "UTC").Every(); d != 90*time.Minute {
		t.Errorf("Every() = %v", d)
	}
	if d := mustParse(t, "0 * * * *", "UTC").Every(); d != 0 {
		t.Errorf("cron Every() = %v", d)
	}
}

func TestNextSequences(t *testing.T) {
	tests := []struct {
		name, expr, zone, after string
		want                    []string
	}{
		{"every 15 minutes", "*/15 * * * *", "UTC", "2026-01-01T00:07:00Z",
			[]string{"2026-01-01T00:15:00Z", "2026-01-01T00:30:00Z", "2026-01-01T00:45:00Z", "2026-01-01T01:00:00Z"}},
		{"after exactly on occurrence", "*/15 * * * *", "UTC", "2026-01-01T00:15:00Z",
			[]string{"2026-01-01T00:30:00Z"}},
		{"sub-second after", "0 * * * *", "UTC", "2026-01-01T00:59:59.999Z",
			[]string{"2026-01-01T01:00:00Z"}},
		{"daily warsaw month boundary", "0 9 * * *", "Europe/Warsaw", "2026-01-30T12:00:00Z",
			[]string{"2026-01-31T08:00:00Z", "2026-02-01T08:00:00Z", "2026-02-02T08:00:00Z"}},
		{"daily warsaw across spring", "0 9 * * *", "Europe/Warsaw", "2026-03-28T00:00:00Z",
			[]string{"2026-03-28T08:00:00Z", "2026-03-29T07:00:00Z", "2026-03-30T07:00:00Z"}},
		{"leap day", "0 0 29 2 *", "UTC", "2026-03-01T00:00:00Z",
			[]string{"2028-02-29T00:00:00Z", "2032-02-29T00:00:00Z"}},
		{"monthly warsaw", "@monthly", "Europe/Warsaw", "2026-01-15T00:00:00Z",
			[]string{"2026-01-31T23:00:00Z", "2026-02-28T23:00:00Z", "2026-03-31T22:00:00Z"}},
		{"yearly", "@yearly", "UTC", "2026-06-01T00:00:00Z",
			[]string{"2027-01-01T00:00:00Z", "2028-01-01T00:00:00Z"}},
		{"weekly is sunday", "@weekly", "UTC", "2026-10-01T00:00:00Z",
			[]string{"2026-10-04T00:00:00Z", "2026-10-11T00:00:00Z"}},
		{"dow 7 is sunday", "0 12 * * 7", "UTC", "2026-10-01T00:00:00Z",
			[]string{"2026-10-04T12:00:00Z", "2026-10-11T12:00:00Z"}},
		{"dow range ending in 7", "0 12 * * 6-7", "UTC", "2026-10-01T00:00:00Z",
			[]string{"2026-10-03T12:00:00Z", "2026-10-04T12:00:00Z", "2026-10-10T12:00:00Z"}},
		{"dow 1/2 stops at saturday", "0 12 * * 1/2", "UTC", "2026-10-01T00:00:00Z",
			[]string{"2026-10-02T12:00:00Z", "2026-10-05T12:00:00Z", "2026-10-07T12:00:00Z", "2026-10-09T12:00:00Z", "2026-10-12T12:00:00Z"}},
		{"mon-fri", "0 9 * * MON-FRI", "UTC", "2026-01-02T10:00:00Z",
			[]string{"2026-01-05T09:00:00Z", "2026-01-06T09:00:00Z"}},
		{"names", "0 9 1 jan,Jul *", "UTC", "2026-01-02T00:00:00Z",
			[]string{"2026-07-01T09:00:00Z", "2027-01-01T09:00:00Z"}},
		{"dom step OR dow", "0 0 */2 * MON", "UTC", "2026-10-01T00:00:00Z",
			[]string{"2026-10-03T00:00:00Z", "2026-10-05T00:00:00Z", "2026-10-07T00:00:00Z", "2026-10-09T00:00:00Z",
				"2026-10-11T00:00:00Z", "2026-10-12T00:00:00Z", "2026-10-13T00:00:00Z"}},
		{"dom star-1 AND dow", "0 0 */1 * MON", "UTC", "2026-10-01T00:00:00Z",
			[]string{"2026-10-05T00:00:00Z", "2026-10-12T00:00:00Z"}},
		{"dom list OR dow", "0 0 1,15 * FRI", "UTC", "2026-10-01T00:00:00Z",
			[]string{"2026-10-02T00:00:00Z", "2026-10-09T00:00:00Z", "2026-10-15T00:00:00Z", "2026-10-16T00:00:00Z"}},

		{"ny spring gap daily", "30 2 * * *", "America/New_York", "2026-03-07T12:00:00Z",
			[]string{"2026-03-08T07:00:00Z", "2026-03-09T06:30:00Z"}},
		{"ny fall repeated daily", "30 1 * * *", "America/New_York", "2026-10-31T12:00:00Z",
			[]string{"2026-11-01T05:30:00Z", "2026-11-02T06:30:00Z"}},
		{"ny fall after repeat daily", "30 2 * * *", "America/New_York", "2026-10-31T12:00:00Z",
			[]string{"2026-11-01T07:30:00Z", "2026-11-02T07:30:00Z"}},
		{"warsaw spring gap daily", "30 2 * * *", "Europe/Warsaw", "2026-03-28T12:00:00Z",
			[]string{"2026-03-29T01:00:00Z", "2026-03-30T00:30:00Z"}},
		{"warsaw fall repeated daily", "30 2 * * *", "Europe/Warsaw", "2026-10-24T12:00:00Z",
			[]string{"2026-10-25T00:30:00Z", "2026-10-26T01:30:00Z"}},
		{"ny hourly fall", "0 * * * *", "America/New_York", "2026-11-01T03:30:00Z",
			[]string{"2026-11-01T04:00:00Z", "2026-11-01T05:00:00Z", "2026-11-01T07:00:00Z", "2026-11-01T08:00:00Z"}},
		{"ny hourly spring", "0 * * * *", "America/New_York", "2026-03-08T05:30:00Z",
			[]string{"2026-03-08T06:00:00Z", "2026-03-08T07:00:00Z", "2026-03-08T08:00:00Z"}},
		{"warsaw hourly fall", "0 * * * *", "Europe/Warsaw", "2026-10-24T23:30:00Z",
			[]string{"2026-10-25T00:00:00Z", "2026-10-25T02:00:00Z", "2026-10-25T03:00:00Z"}},
		{"ny half-hourly spring", "*/30 * * * *", "America/New_York", "2026-03-08T04:59:00Z",
			[]string{"2026-03-08T05:00:00Z", "2026-03-08T05:30:00Z", "2026-03-08T06:00:00Z", "2026-03-08T06:30:00Z",
				"2026-03-08T07:00:00Z", "2026-03-08T07:30:00Z", "2026-03-08T08:00:00Z"}},
		{"ny half-hourly fall", "*/30 * * * *", "America/New_York", "2026-11-01T03:59:00Z",
			[]string{"2026-11-01T04:00:00Z", "2026-11-01T04:30:00Z", "2026-11-01T05:00:00Z", "2026-11-01T05:30:00Z",
				"2026-11-01T07:00:00Z", "2026-11-01T07:30:00Z"}},
		{"warsaw half-hourly spring", "*/30 * * * *", "Europe/Warsaw", "2026-03-29T00:00:00Z",
			[]string{"2026-03-29T00:30:00Z", "2026-03-29T01:00:00Z", "2026-03-29T01:30:00Z", "2026-03-29T02:00:00Z"}},
		{"warsaw half-hourly fall", "*/30 * * * *", "Europe/Warsaw", "2026-10-24T23:59:00Z",
			[]string{"2026-10-25T00:00:00Z", "2026-10-25T00:30:00Z", "2026-10-25T02:00:00Z", "2026-10-25T02:30:00Z"}},
		{"sao paulo midnight gap", "0 0 * * *", "America/Sao_Paulo", "2018-11-03T12:00:00Z",
			[]string{"2018-11-04T03:00:00Z", "2018-11-05T02:00:00Z"}},
		{"lord howe half-hour gap", "15 2 * * *", "Australia/Lord_Howe", "2026-10-03T00:00:00Z",
			[]string{"2026-10-03T15:30:00Z", "2026-10-04T15:15:00Z"}},

		{"second pass half-hourly", "*/30 * * * *", "America/New_York", "2026-11-01T06:15:00Z",
			[]string{"2026-11-01T07:00:00Z"}},
		{"second pass on repeated occurrence", "*/30 * * * *", "America/New_York", "2026-11-01T06:30:00Z",
			[]string{"2026-11-01T07:00:00Z"}},
		{"second pass hourly", "0 * * * *", "America/New_York", "2026-11-01T06:00:00Z",
			[]string{"2026-11-01T07:00:00Z"}},
		{"second pass daily in repeated hour", "30 1 * * *", "America/New_York", "2026-11-01T06:15:00Z",
			[]string{"2026-11-02T06:30:00Z"}},
		{"on gap end", "*/30 * * * *", "America/New_York", "2026-03-08T07:00:00Z",
			[]string{"2026-03-08T07:30:00Z"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			x := mustParse(t, tt.expr, tt.zone)
			cur := ts(t, tt.after)
			for i, w := range tt.want {
				got, err := x.Next(cur, time.Time{})
				if err != nil {
					t.Fatalf("step %d: %v", i, err)
				}
				if want := ts(t, w); !got.Equal(want) {
					t.Fatalf("step %d after %s: got %s, want %s", i, cur.UTC().Format(time.RFC3339), got.UTC().Format(time.RFC3339), w)
				}
				if got.Location() != x.Location() {
					t.Fatalf("step %d: location %s", i, got.Location())
				}
				cur = got
			}
		})
	}
}

func TestNextNever(t *testing.T) {
	for _, tt := range []struct{ expr, after string }{
		{"0 0 30 2 *", "2026-01-01T00:00:00Z"},
		{"0 0 31 4,6,9,11 *", "2026-01-01T00:00:00Z"},
		{"0 0 29 2 *", "2096-03-01T00:00:00Z"},
	} {
		x := mustParse(t, tt.expr, "UTC")
		if got, err := x.Next(ts(t, tt.after), time.Time{}); !errors.Is(err, ErrNever) {
			t.Errorf("%s: Next = %v, %v; want ErrNever", tt.expr, got, err)
		}
	}
}

func TestNextEvery(t *testing.T) {
	x := mustParse(t, "@every 90m", "UTC")
	anchor := ts(t, "2026-01-01T00:00:00Z")
	tests := []struct{ after, want string }{
		{"2026-01-01T02:00:00Z", "2026-01-01T03:00:00Z"},
		{"2026-01-01T03:00:00Z", "2026-01-01T04:30:00Z"},
		{"2026-01-01T00:00:00Z", "2026-01-01T01:30:00Z"},
		{"2025-12-31T23:59:59Z", "2026-01-01T00:00:00Z"},
		{"2020-01-01T00:00:00Z", "2026-01-01T00:00:00Z"},
		{"2026-01-11T00:00:00.5Z", "2026-01-11T01:30:00Z"},
	}
	for _, tt := range tests {
		got, err := x.Next(ts(t, tt.after), anchor)
		if err != nil || !got.Equal(ts(t, tt.want)) {
			t.Errorf("Next(%s) = %v, %v; want %s", tt.after, got, err, tt.want)
		}
	}
	if _, err := x.Next(anchor, time.Time{}); err == nil {
		t.Error("zero anchor accepted")
	}

	ny := mustParse(t, "@every 1h", "America/New_York")
	nyAnchor := ts(t, "2026-11-01T04:00:00Z")
	cur := ts(t, "2026-11-01T04:30:00Z")
	for _, w := range []string{"2026-11-01T05:00:00Z", "2026-11-01T06:00:00Z", "2026-11-01T07:00:00Z"} {
		got, err := ny.Next(cur, nyAnchor)
		if err != nil || !got.Equal(ts(t, w)) {
			t.Fatalf("NY every after %s = %v, %v; want %s", cur, got, err, w)
		}
		cur = got
	}
}

func TestDue(t *testing.T) {
	tests := []struct {
		name, expr, zone, from, now, anchor string
		limit                               int
		count                               int64
		first, latest                       string
		capped                              bool
	}{
		{"hourly", "0 * * * *", "UTC", "2026-01-01T00:00:00Z", "2026-01-01T05:30:00Z", "", 100,
			6, "2026-01-01T00:00:00Z", "2026-01-01T05:00:00Z", false},
		{"from mid", "0 * * * *", "UTC", "2026-01-01T00:00:01Z", "2026-01-01T05:00:00Z", "", 100,
			5, "2026-01-01T01:00:00Z", "2026-01-01T05:00:00Z", false},
		{"from equals now on occurrence", "0 * * * *", "UTC", "2026-01-01T03:00:00Z", "2026-01-01T03:00:00Z", "", 10,
			1, "2026-01-01T03:00:00Z", "2026-01-01T03:00:00Z", false},
		{"from equals now off occurrence", "0 * * * *", "UTC", "2026-01-01T03:10:00Z", "2026-01-01T03:10:00Z", "", 10,
			0, "", "", false},
		{"from after now", "0 * * * *", "UTC", "2026-01-01T05:00:00Z", "2026-01-01T03:00:00Z", "", 10,
			0, "", "", false},
		{"capped dense", "* * * * *", "UTC", "2026-01-01T00:00:00Z", "2026-01-01T03:00:30Z", "", 10,
			10, "2026-01-01T00:00:00Z", "2026-01-01T03:00:00Z", true},
		{"exactly limit", "0 * * * *", "UTC", "2026-01-01T00:00:00Z", "2026-01-01T02:00:00Z", "", 3,
			3, "2026-01-01T00:00:00Z", "2026-01-01T02:00:00Z", false},
		{"capped sparse", "0 9 * * MON-FRI", "Europe/Warsaw", "2026-01-01T00:00:00Z", "2026-06-15T12:00:00Z", "", 5,
			5, "2026-01-01T08:00:00Z", "2026-06-15T07:00:00Z", true},
		{"capped repeated hour", "*/30 * * * *", "America/New_York", "2026-11-01T04:00:00Z", "2026-11-01T06:45:00Z", "", 2,
			2, "2026-11-01T04:00:00Z", "2026-11-01T05:30:00Z", true},
		{"capped gap end", "*/30 * * * *", "America/New_York", "2026-03-08T05:00:00Z", "2026-03-08T07:15:00Z", "", 1,
			1, "2026-03-08T05:00:00Z", "2026-03-08T07:00:00Z", true},
		{"never", "0 0 30 2 *", "UTC", "2026-01-01T00:00:00Z", "2030-01-01T00:00:00Z", "", 10,
			0, "", "", false},
		{"every", "@every 15m", "UTC", "2026-01-01T00:10:00Z", "2026-01-01T01:00:00Z", "2026-01-01T00:00:00Z", 10,
			4, "2026-01-01T00:15:00Z", "2026-01-01T01:00:00Z", false},
		{"every from equals now", "@every 15m", "UTC", "2026-01-01T00:30:00Z", "2026-01-01T00:30:00Z", "2026-01-01T00:00:00Z", 10,
			1, "2026-01-01T00:30:00Z", "2026-01-01T00:30:00Z", false},
		{"every from equals now off", "@every 15m", "UTC", "2026-01-01T00:31:00Z", "2026-01-01T00:31:00Z", "2026-01-01T00:00:00Z", 10,
			0, "", "", false},
		{"every from after now", "@every 15m", "UTC", "2026-01-01T01:00:00Z", "2026-01-01T00:30:00Z", "2026-01-01T00:00:00Z", 10,
			0, "", "", false},
		{"every capped", "@every 15m", "UTC", "2026-01-01T00:10:00Z", "2026-01-01T01:00:00Z", "2026-01-01T00:00:00Z", 2,
			2, "2026-01-01T00:15:00Z", "2026-01-01T01:00:00Z", true},
		{"every from before anchor", "@every 15m", "UTC", "2025-01-01T00:00:00Z", "2026-01-01T00:20:00Z", "2026-01-01T00:00:00Z", 10,
			2, "2026-01-01T00:00:00Z", "2026-01-01T00:15:00Z", false},
		{"every now before anchor", "@every 15m", "UTC", "2025-01-01T00:00:00Z", "2025-12-31T00:00:00Z", "2026-01-01T00:00:00Z", 10,
			0, "", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			x := mustParse(t, tt.expr, tt.zone)
			var anchor time.Time
			if tt.anchor != "" {
				anchor = ts(t, tt.anchor)
			}
			got, err := x.Due(ts(t, tt.from), ts(t, tt.now), anchor, tt.limit)
			if err != nil {
				t.Fatal(err)
			}
			if got.Count != tt.count || got.Capped != tt.capped {
				t.Fatalf("Count/Capped = %d/%v, want %d/%v", got.Count, got.Capped, tt.count, tt.capped)
			}
			check := func(field string, v time.Time, want string) {
				if want == "" {
					if !v.IsZero() {
						t.Errorf("%s = %s, want zero", field, v)
					}
					return
				}
				if !v.Equal(ts(t, want)) {
					t.Errorf("%s = %s, want %s", field, v.UTC().Format(time.RFC3339), want)
				}
			}
			check("First", got.First, tt.first)
			check("Latest", got.Latest, tt.latest)
		})
	}

	x := mustParse(t, "0 * * * *", "UTC")
	now := ts(t, "2026-01-01T00:00:00Z")
	if _, err := x.Due(now, now, time.Time{}, 0); err == nil {
		t.Error("limit 0 accepted")
	}
	if _, err := mustParse(t, "@every 1h", "UTC").Due(now, now, time.Time{}, 1); err == nil {
		t.Error("@every Due accepted zero anchor")
	}
}

// TestDueCappedLatestMatchesEnumeration compares the binary-searched Latest
// with full enumeration.
func TestDueCappedLatestMatchesEnumeration(t *testing.T) {
	cases := []struct{ expr, zone, from, now string }{
		{"*/30 * * * *", "America/New_York", "2026-10-31T00:00:00Z", "2026-11-01T06:59:59Z"},
		{"*/30 * * * *", "America/New_York", "2026-03-07T00:00:00Z", "2026-03-08T07:00:00Z"},
		{"30 2 * * *", "Europe/Warsaw", "2026-03-01T00:00:00Z", "2026-03-29T01:00:00.5Z"},
		{"7 3 */3 * *", "UTC", "2026-01-01T00:00:00Z", "2026-07-19T03:07:00Z"},
		{"0 0 29 2 *", "UTC", "2016-01-01T00:00:00Z", "2030-01-01T00:00:00Z"},
	}
	for _, c := range cases {
		x := mustParse(t, c.expr, c.zone)
		from, now := ts(t, c.from), ts(t, c.now)
		full, err := x.Due(from, now, time.Time{}, 1<<20)
		if err != nil || full.Capped || full.Count < 3 {
			t.Fatalf("%s: full = %+v, %v", c.expr, full, err)
		}
		capped, err := x.Due(from, now, time.Time{}, 2)
		if err != nil {
			t.Fatal(err)
		}
		if !capped.Capped || capped.Count != 2 || !capped.First.Equal(full.First) || !capped.Latest.Equal(full.Latest) {
			t.Errorf("%s %s: capped %+v, full %+v", c.expr, c.zone, capped, full)
		}
	}
}

func TestLocalZone(t *testing.T) {
	for _, tt := range []struct{ tz, want string }{
		{"Europe/Warsaw", "Europe/Warsaw"},
		{":America/New_York", "America/New_York"},
		{"/usr/share/zoneinfo/Asia/Tokyo", "Asia/Tokyo"},
		{"UTC", "UTC"},
	} {
		t.Setenv("TZ", tt.tz)
		if got := LocalZone(); got != tt.want {
			t.Errorf("TZ=%q: LocalZone() = %q, want %q", tt.tz, got, tt.want)
		}
	}
	for _, tz := range []string{"Invalid/Zone", "Local", "", ":"} {
		t.Setenv("TZ", tz)
		got := LocalZone()
		if got == "" || got == "Local" || got == "Invalid/Zone" {
			t.Errorf("TZ=%q: LocalZone() = %q", tz, got)
		}
		if _, err := time.LoadLocation(got); err != nil {
			t.Errorf("TZ=%q: LocalZone() = %q not loadable: %v", tz, got, err)
		}
	}
	t.Setenv("TZ", "Asia/Tokyo")
	if x := mustParse(t, "0 0 * * *", ""); x.Timezone() != "Asia/Tokyo" {
		t.Errorf("default zone = %q", x.Timezone())
	}
}

func TestFormatLocal(t *testing.T) {
	ny, _ := time.LoadLocation("America/New_York")
	ms := ts(t, "2026-03-08T07:00:00Z").UnixMilli()
	tests := []struct {
		ms   int64
		loc  *time.Location
		want string
	}{
		{0, ny, ""},
		{ms, ny, "2026-03-08T03:00:00-04:00"},
		{ms - 1000, ny, "2026-03-08T01:59:59-05:00"},
		{ms, time.UTC, "2026-03-08T07:00:00Z"},
		{ms, nil, "2026-03-08T07:00:00Z"},
	}
	for _, tt := range tests {
		if got := FormatLocal(tt.ms, tt.loc); got != tt.want {
			t.Errorf("FormatLocal(%d, %v) = %q, want %q", tt.ms, tt.loc, got, tt.want)
		}
	}
}

func civilOf(t time.Time) civil {
	return civil{t.Year(), int(t.Month()), t.Day(), t.Hour(), t.Minute()}
}

func wallKey(t time.Time) int64 {
	_, off := t.Zone()
	return t.Unix() + int64(off)
}

func (s *spec) matches(c civil) bool {
	return s.month&(1<<c.mo) != 0 && s.dayMatches(c.y, c.mo, c.d) &&
		s.hour&(1<<c.h) != 0 && s.minute&(1<<c.mi) != 0
}

// TestNextProperties iterates Next and checks ordering, field matching, gap
// handling and that no wall-clock minute fires twice.
func TestNextProperties(t *testing.T) {
	cases := []struct{ expr, zone, start string }{
		{"*/7 * * * *", "America/New_York", "2026-10-31T00:00:00Z"},
		{"*/7 * * * *", "Australia/Lord_Howe", "2026-10-02T00:00:00Z"},
		{"* 1-3 * * *", "Europe/Warsaw", "2026-03-27T00:00:00Z"},
		{"* 1-3 * * *", "Europe/Warsaw", "2026-10-23T00:00:00Z"},
		{"* 0 * * *", "America/Sao_Paulo", "2018-11-02T00:00:00Z"},
		{"30 2 * * *", "America/New_York", "2020-01-01T00:00:00Z"},
		{"0 * * * *", "Europe/Warsaw", "2026-01-01T00:00:00Z"},
		{"15,45 1-3 * * *", "Australia/Lord_Howe", "2026-01-01T00:00:00Z"},
		{"0 0 */2 * MON", "America/Sao_Paulo", "2015-01-01T00:00:00Z"},
		{"@daily", "America/Sao_Paulo", "2014-01-01T00:00:00Z"},
		{"5 4 * * sun", "UTC", "2026-01-01T00:00:00Z"},
	}
	for _, c := range cases {
		x := mustParse(t, c.expr, c.zone)
		prev := ts(t, c.start)
		seen := map[civil]bool{}
		for i := range 2000 {
			got, err := x.Next(prev, time.Time{})
			if err != nil {
				t.Fatalf("%s %s step %d: %v", c.expr, c.zone, i, err)
			}
			if !got.After(prev) {
				t.Fatalf("%s %s step %d: %s not after %s", c.expr, c.zone, i, got, prev)
			}
			w := got.In(x.loc)
			cv := civilOf(w)
			if w.Second() != 0 || !x.spec.matches(cv) {
				start, _ := got.ZoneBounds()
				if !start.Equal(got) {
					t.Fatalf("%s %s step %d: %s neither matches nor is a transition", c.expr, c.zone, i, w)
				}
				before := got.Add(-time.Second).In(x.loc)
				gap, ok := x.spec.next(civilOf(before).addMinute(), w.Year()+1)
				if !ok || gap.unix() >= wallKey(got) {
					t.Fatalf("%s %s step %d: transition %s skips no matching time", c.expr, c.zone, i, w)
				}
			} else if !resolve(cv, x.loc).Equal(got) {
				t.Fatalf("%s %s step %d: %s is not the first instant of its wall time", c.expr, c.zone, i, w)
			}
			if seen[cv] {
				t.Fatalf("%s %s step %d: wall time %v fired twice", c.expr, c.zone, i, cv)
			}
			seen[cv] = true
			prev = got
		}
	}
}

// TestNextOracle compares Next with a minute-by-minute scan of instants
// around DST transitions. An instant is an occurrence when its wall clock
// matches and has not been seen before in the window, or when it ends a
// forward jump that skipped a matching wall time.
func TestNextOracle(t *testing.T) {
	windows := []struct{ zone, start string }{
		{"America/New_York", "2026-03-07T00:00:00Z"},
		{"America/New_York", "2026-10-31T00:00:00Z"},
		{"Europe/Warsaw", "2026-03-28T00:00:00Z"},
		{"Europe/Warsaw", "2026-10-24T00:00:00Z"},
		{"America/Sao_Paulo", "2018-11-03T00:00:00Z"},
		{"America/Sao_Paulo", "2018-02-16T00:00:00Z"},
		{"Australia/Lord_Howe", "2026-04-03T00:00:00Z"},
		{"Australia/Lord_Howe", "2026-10-02T00:00:00Z"},
	}
	exprs := []string{"*/30 * * * *", "0 * * * *", "30 2 * * *", "30 1 * * *", "0 0 * * *", "15,45 0-3 * * *", "59 23 * * *"}
	for _, win := range windows {
		for _, expr := range exprs {
			x := mustParse(t, expr, win.zone)
			start := ts(t, win.start)
			end := start.Add(72 * time.Hour)
			var want []time.Time
			seen := map[civil]bool{}
			prevKey := wallKey(start.Add(-time.Minute).In(x.loc))
			for i := start.Add(-24 * time.Hour); !i.After(end); i = i.Add(time.Minute) {
				w := i.In(x.loc)
				key := wallKey(w)
				cv := civilOf(w)
				hit := !seen[cv] && x.spec.matches(cv)
				if i.Before(start) {
					seen[cv] = true
					prevKey = key
					continue
				}
				for k := prevKey + 60; !hit && k < key; k += 60 {
					hit = x.spec.matches(civilOf(time.Unix(k, 0).UTC()))
				}
				seen[cv] = true
				prevKey = key
				if hit && i.After(start) {
					want = append(want, i)
				}
			}
			var got []time.Time
			for cur := start; ; {
				n, err := x.Next(cur, time.Time{})
				if err != nil {
					t.Fatal(err)
				}
				if n.After(end) {
					break
				}
				got = append(got, n)
				cur = n
			}
			if len(got) != len(want) {
				t.Fatalf("%s %s: got %d occurrences, want %d\ngot  %v\nwant %v", win.zone, expr, len(got), len(want), utcList(got), utcList(want))
			}
			for i := range got {
				if !got[i].Equal(want[i]) {
					t.Fatalf("%s %s: occurrence %d = %s, want %s", win.zone, expr, i, got[i].UTC(), want[i].UTC())
				}
			}
		}
	}
}

func utcList(ts []time.Time) string {
	var b strings.Builder
	for _, t := range ts {
		b.WriteString(t.UTC().Format("01-02T15:04 "))
	}
	return b.String()
}
