package heartbeat

import (
	"testing"
	"time"
)

func TestMatchesCron(t *testing.T) {
	now := time.Date(2026, 1, 5, 10, 30, 0, 0, time.UTC)
	if !MatchesCron("* * * * *", now) {
		t.Fatal("wildcard")
	}
	if !MatchesCron("30 10 * * *", now) {
		t.Fatal("exact minute")
	}
	if MatchesCron("31 10 * * *", now) {
		t.Fatal("wrong minute")
	}
	if !MatchesCron("*/5 * * * *", time.Date(2026, 1, 5, 10, 35, 0, 0, time.UTC)) {
		t.Fatal("step")
	}
}

func TestNextRunFromUTC(t *testing.T) {
	from := time.Date(2026, 3, 28, 12, 0, 0, 0, time.UTC)
	next, ok := NextRunFrom("0 * * * *", "UTC", from)
	if !ok {
		t.Fatal("expected next")
	}
	wall := next.In(time.UTC)
	if wall.Minute() != 0 || wall.Hour() != 13 {
		t.Fatalf("got %v want 13:00 UTC", wall)
	}
}

func TestClassifyHealthy(t *testing.T) {
	created := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	// Every minute: prev fire is on or before "now", ping just after prev
	now := time.Date(2026, 1, 5, 10, 30, 0, 0, time.UTC)
	prev, _ := PrevRunAtOrBefore("* * * * *", "UTC", now)
	hb := prev.Add(30 * time.Second)
	st := Classify("* * * * *", "UTC", 300, created, &hb, now)
	if st.Status != StatusHealthy {
		t.Fatalf("want healthy got %s", st.Status)
	}
}

func TestClassifyNever(t *testing.T) {
	created := time.Date(2026, 3, 28, 10, 0, 0, 0, time.UTC)
	now := time.Date(2026, 3, 28, 10, 0, 30, 0, time.UTC)
	st := Classify("* * * * *", "UTC", 300, created, nil, now)
	if st.Status != StatusNever {
		t.Fatalf("want never got %s", st.Status)
	}
}

func TestClassifyDeadNoPing(t *testing.T) {
	created := time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)
	now := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
	st := Classify("0 * * * *", "UTC", 60, created, nil, now)
	if st.Status != StatusDead {
		t.Fatalf("want dead got %s", st.Status)
	}
}

func TestAbsenceAlertAlreadySentForWindow(t *testing.T) {
	prev := time.Date(2026, 3, 28, 10, 0, 0, 0, time.UTC)
	alert := time.Date(2026, 3, 28, 10, 5, 0, 0, time.UTC)
	if !AbsenceAlertAlreadySentForWindow(&alert, prev) {
		t.Fatal("alert after prev should dedupe")
	}
	old := time.Date(2026, 3, 28, 9, 0, 0, 0, time.UTC)
	if AbsenceAlertAlreadySentForWindow(&old, prev) {
		t.Fatal("alert before prev window should not dedupe")
	}
	if AbsenceAlertAlreadySentForWindow(nil, prev) {
		t.Fatal("no prior alert should not dedupe")
	}
}

func TestTokenRateLimiter(t *testing.T) {
	r := NewTokenRateLimiter(10 * time.Second)
	now := time.Now()
	if !r.Allow("a", now) {
		t.Fatal("first allow")
	}
	if r.Allow("a", now) {
		t.Fatal("second same instant should deny")
	}
	if !r.Allow("a", now.Add(11*time.Second)) {
		t.Fatal("after gap should allow")
	}
}
