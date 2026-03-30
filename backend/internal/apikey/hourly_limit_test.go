package apikey

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestHourlyLimiterUnderLimit(t *testing.T) {
	h := NewHourlyLimiter(3)
	id := uuid.MustParse("22222222-2222-2222-2222-222222222222")
	now := time.Date(2026, 1, 1, 10, 30, 0, 0, time.UTC)
	if !h.Allow(id, now) || !h.Allow(id, now) || !h.Allow(id, now) {
		t.Fatal("expected first 3 allows")
	}
	if h.Allow(id, now) {
		t.Fatal("expected 4th request blocked in same hour bucket")
	}
}

func TestHourlyLimiterResetsNextHour(t *testing.T) {
	h := NewHourlyLimiter(1)
	id := uuid.MustParse("33333333-3333-3333-3333-333333333333")
	t0 := time.Unix(3600*100, 0).UTC()
	if !h.Allow(id, t0) {
		t.Fatal("first allow")
	}
	if h.Allow(id, t0) {
		t.Fatal("second blocked same hour")
	}
	t1 := t0.Add(time.Hour)
	if !h.Allow(id, t1) {
		t.Fatal("allow after hour boundary")
	}
}
