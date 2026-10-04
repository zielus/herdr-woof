// The cron field parser in this file is adapted from robfig/cron v3.0.1
// (parser.go, spec.go), as used through cron.ParseStandard by herdr-orch
// (MIT, Copyright (c) 2026 Stephen Ellington). robfig/cron is MIT licensed,
// Copyright (C) 2012 Rob Figueiredo; see LICENSE.robfig-cron.
//
// Changes from the original: only the five standard fields are accepted,
// empty list items, "*-N", signed numbers and trailing tokens are rejected,
// day-of-week accepts 7 for Sunday, and descriptors are case-insensitive.

package schedule

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

type bounds struct {
	min, max uint
	// stepMax is the upper end used by "*" and "N/step"; it differs from max
	// only for day-of-week, where 7 is an explicit-only alias for Sunday.
	stepMax uint
	names   map[string]uint
}

var (
	minutes = bounds{0, 59, 59, nil}
	hours   = bounds{0, 23, 23, nil}
	doms    = bounds{1, 31, 31, nil}
	months  = bounds{1, 12, 12, map[string]uint{
		"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
		"jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
	}}
	dows = bounds{0, 7, 6, map[string]uint{
		"sun": 0, "mon": 1, "tue": 2, "wed": 3, "thu": 4, "fri": 5, "sat": 6,
	}}
)

// starBit marks a field written as "*" or "?" with step 1; DOM/DOW matching
// depends on it.
const starBit = 1 << 63

type spec struct {
	minute, hour, dom, month, dow uint64
}

func parseFields(fields []string) (spec, error) {
	if len(fields) != 5 {
		return spec{}, fmt.Errorf("expected exactly 5 fields, found %d", len(fields))
	}
	var s spec
	var err error
	targets := []*uint64{&s.minute, &s.hour, &s.dom, &s.month, &s.dow}
	for i, r := range []bounds{minutes, hours, doms, months, dows} {
		if *targets[i], err = getField(fields[i], r); err != nil {
			return spec{}, err
		}
	}
	if s.dow&(1<<7) != 0 {
		s.dow = s.dow&^(1<<7) | 1
	}
	return s, nil
}

// getField parses a comma-separated list of ranges into a bit set.
func getField(field string, r bounds) (uint64, error) {
	var bits uint64
	for _, expr := range strings.Split(field, ",") {
		if expr == "" {
			return 0, fmt.Errorf("empty list item in %q", field)
		}
		bit, err := getRange(expr, r)
		if err != nil {
			return 0, err
		}
		bits |= bit
	}
	return bits, nil
}

// getRange parses "*", "?", "N", "N-M", each optionally followed by "/step".
// "N/step" means N through the field maximum.
func getRange(expr string, r bounds) (uint64, error) {
	rangeAndStep := strings.Split(expr, "/")
	if len(rangeAndStep) > 2 {
		return 0, fmt.Errorf("too many slashes: %s", expr)
	}
	lowAndHigh := strings.Split(rangeAndStep[0], "-")
	if len(lowAndHigh) > 2 {
		return 0, fmt.Errorf("too many hyphens: %s", expr)
	}

	var start, end uint
	var extra uint64
	var err error
	if lowAndHigh[0] == "*" || lowAndHigh[0] == "?" {
		if len(lowAndHigh) != 1 {
			return 0, fmt.Errorf("wildcard cannot start a range: %s", expr)
		}
		start, end, extra = r.min, r.stepMax, starBit
	} else {
		if start, err = parseIntOrName(lowAndHigh[0], r.names); err != nil {
			return 0, err
		}
		end = start
		if len(lowAndHigh) == 2 {
			if end, err = parseIntOrName(lowAndHigh[1], r.names); err != nil {
				return 0, err
			}
		}
	}

	step := uint(1)
	if len(rangeAndStep) == 2 {
		if step, err = parseUint(rangeAndStep[1]); err != nil {
			return 0, err
		}
		if len(lowAndHigh) == 1 && extra == 0 {
			end = r.stepMax
			if start > end {
				return 0, fmt.Errorf("beginning of range (%d) beyond end of range (%d): %s", start, end, expr)
			}
		}
		if step > 1 {
			extra = 0
		}
	}

	if start < r.min {
		return 0, fmt.Errorf("beginning of range (%d) below minimum (%d): %s", start, r.min, expr)
	}
	if end > r.max {
		return 0, fmt.Errorf("end of range (%d) above maximum (%d): %s", end, r.max, expr)
	}
	if start > end {
		return 0, fmt.Errorf("beginning of range (%d) beyond end of range (%d): %s", start, end, expr)
	}
	if step == 0 {
		return 0, fmt.Errorf("step of range should be a positive number: %s", expr)
	}
	return getBits(start, end, step) | extra, nil
}

func parseIntOrName(expr string, names map[string]uint) (uint, error) {
	if n, ok := names[strings.ToLower(expr)]; ok {
		return n, nil
	}
	return parseUint(expr)
}

func parseUint(expr string) (uint, error) {
	if expr == "" || strings.TrimLeft(expr, "0123456789") != "" {
		return 0, fmt.Errorf("invalid number %q", expr)
	}
	n, err := strconv.ParseUint(expr, 10, 16)
	if err != nil {
		return 0, fmt.Errorf("invalid number %q", expr)
	}
	return uint(n), nil
}

func getBits(min, max, step uint) uint64 {
	if step == 1 {
		return ^(math.MaxUint64 << (max + 1)) & (math.MaxUint64 << min)
	}
	var bits uint64
	for i := min; i <= max; i += step {
		bits |= 1 << i
	}
	return bits
}

func all(r bounds) uint64 {
	return getBits(r.min, r.stepMax, 1) | starBit
}

// descriptors maps the named schedules to their equivalent specs.
var descriptors = map[string]spec{
	"@yearly":   {1, 1, 1 << 1, 1 << 1, all(dows)},
	"@annually": {1, 1, 1 << 1, 1 << 1, all(dows)},
	"@monthly":  {1, 1, 1 << 1, all(months), all(dows)},
	"@weekly":   {1, 1, all(doms), all(months), 1},
	"@daily":    {1, 1, all(doms), all(months), all(dows)},
	"@midnight": {1, 1, all(doms), all(months), all(dows)},
	"@hourly":   {1, all(hours), all(doms), all(months), all(dows)},
}
