// Package heartbeat implements cron-based next/prev run probes (minute resolution) and status.
package heartbeat

import (
	"strconv"
	"strings"
	"time"
)

const maxProbeMinutes = 60 * 24 * 366

// MatchesCron reports whether spec (5-field cron) matches the wall clock of now in its location.
func MatchesCron(spec string, now time.Time) bool {
	fields := strings.Fields(spec)
	if len(fields) != 5 {
		return false
	}
	min, hr, day, mon, dow := fields[0], fields[1], fields[2], fields[3], fields[4]
	return matchField(min, now.Minute()) &&
		matchField(hr, now.Hour()) &&
		matchField(day, now.Day()) &&
		matchField(mon, int(now.Month())) &&
		matchField(dow, int(now.Weekday()))
}

func matchField(field string, val int) bool {
	if field == "*" {
		return true
	}
	if strings.HasPrefix(field, "*/") {
		n, err := strconv.Atoi(strings.TrimPrefix(field, "*/"))
		return err == nil && n > 0 && val%n == 0
	}
	for _, p := range strings.Split(field, ",") {
		x, err := strconv.Atoi(strings.TrimSpace(p))
		if err == nil && x == val {
			return true
		}
	}
	return false
}

// JobLocation returns *time.Location for a stored timezone name.
func JobLocation(timezone string) *time.Location {
	tz := strings.TrimSpace(timezone)
	if tz == "" || tz == "Local" {
		return time.Local
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		return time.Local
	}
	return loc
}

// NextRunFrom returns the first minute strictly after `from` (UTC instant) where the cron fires in job TZ.
func NextRunFrom(spec string, timezone string, from time.Time) (time.Time, bool) {
	loc := JobLocation(timezone)
	if len(strings.Fields(spec)) != 5 {
		return time.Time{}, false
	}
	t := from.UTC().Truncate(time.Minute).Add(time.Minute)
	for i := 0; i < maxProbeMinutes; i++ {
		wall := t.In(loc)
		if MatchesCron(spec, wall) {
			return t, true
		}
		t = t.Add(time.Minute)
	}
	return time.Time{}, false
}

// PrevRunAtOrBefore returns the latest minute <= `from` (UTC instant) where the cron fires in job TZ.
func PrevRunAtOrBefore(spec string, timezone string, from time.Time) (time.Time, bool) {
	loc := JobLocation(timezone)
	if len(strings.Fields(spec)) != 5 {
		return time.Time{}, false
	}
	t := from.UTC().Truncate(time.Minute)
	for i := 0; i < maxProbeMinutes; i++ {
		wall := t.In(loc)
		if MatchesCron(spec, wall) {
			return t, true
		}
		t = t.Add(-time.Minute)
	}
	return time.Time{}, false
}

// IntervalSeconds returns seconds between two consecutive fires after anchor (minimum 60).
func IntervalSeconds(spec, timezone string, anchor time.Time) int64 {
	n1, ok := NextRunFrom(spec, timezone, anchor)
	if !ok {
		return 3600
	}
	n2, ok := NextRunFrom(spec, timezone, n1)
	if !ok {
		return 3600
	}
	sec := int64(n2.Sub(n1) / time.Second)
	if sec < 60 {
		return 60
	}
	return sec
}

// Status values for API/UI.
const (
	StatusHealthy = "healthy"
	StatusLate    = "late"
	StatusDead    = "dead"
	StatusNever   = "never"
)

const alignSlack = 2 * time.Minute

// State is derived heartbeat classification for one job at `now`.
type State struct {
	Status           string
	PrevFire         time.Time
	NextFire         time.Time
	Deadline         time.Time // nextFire + grace; ping expected by then if none for current period
	IntervalSeconds  int64
	FirstPingDueBy   time.Time // for never/dead with no pings yet
}

// Classify computes heartbeat status. lastHB nil means never received.
func Classify(spec, timezone string, graceSeconds int, createdAt time.Time, lastHB *time.Time, now time.Time) State {
	out := State{Status: StatusNever}
	if graceSeconds < 0 {
		graceSeconds = 0
	}
	grace := time.Duration(graceSeconds) * time.Second

	if len(strings.Fields(spec)) != 5 {
		out.Status = StatusDead
		return out
	}

	firstRun, ok := NextRunFrom(spec, timezone, createdAt.UTC().Add(-time.Minute))
	if !ok {
		out.Status = StatusDead
		return out
	}
	secondRun, ok := NextRunFrom(spec, timezone, firstRun)
	if !ok {
		out.Status = StatusDead
		return out
	}
	out.FirstPingDueBy = secondRun.Add(grace)

	prev, ok := PrevRunAtOrBefore(spec, timezone, now)
	if !ok {
		out.Status = StatusDead
		return out
	}
	next, ok := NextRunFrom(spec, timezone, prev)
	if !ok {
		out.Status = StatusDead
		return out
	}
	out.PrevFire = prev
	out.NextFire = next
	out.Deadline = next.Add(grace)
	out.IntervalSeconds = int64(next.Sub(prev) / time.Second)
	if out.IntervalSeconds < 60 {
		out.IntervalSeconds = 60
	}

	if lastHB == nil {
		if now.Before(out.FirstPingDueBy) {
			out.Status = StatusNever
			return out
		}
		if !now.Before(out.Deadline) {
			out.Status = StatusDead
			return out
		}
		if now.After(out.PrevFire) {
			out.Status = StatusLate
			return out
		}
		out.Status = StatusNever
		return out
	}

	hb := lastHB.UTC()
	covered := !hb.Before(prev.Add(-alignSlack))
	if covered {
		out.Status = StatusHealthy
		return out
	}
	if !now.Before(out.Deadline) {
		out.Status = StatusDead
		return out
	}
	if now.After(out.PrevFire) {
		out.Status = StatusLate
		return out
	}
	out.Status = StatusLate
	return out
}

// AbsenceAlertAlreadySentForWindow is true when we already notified for this missed
// schedule slot (last alert time is on or after prevFire).
func AbsenceAlertAlreadySentForWindow(lastAlertAt *time.Time, prevFire time.Time) bool {
	if lastAlertAt == nil {
		return false
	}
	return !lastAlertAt.UTC().Before(prevFire.UTC())
}
