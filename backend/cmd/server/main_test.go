package main

import (
	"context"
	"testing"
	"time"
)

func TestCronMatch(t *testing.T) {
	now := time.Date(2026, 1, 5, 10, 30, 0, 0, time.UTC)
	if !matchesCron("* * * * *", now) {
		t.Fatal("wildcard cron should match")
	}
	if !matchesCron("30 10 * * *", now) {
		t.Fatal("exact cron should match")
	}
	if matchesCron("31 10 * * *", now) {
		t.Fatal("non-matching minute should fail")
	}
	if !matchesCron("*/5 * * * *", time.Date(2026, 1, 5, 10, 35, 0, 0, time.UTC)) {
		t.Fatal("step cron should match 35")
	}
}

func TestDiagnoseError(t *testing.T) {
	reason, fix := diagnoseError(context.DeadlineExceeded, "")
	if reason == "" || fix == "" {
		t.Fatal("timeout diagnosis should not be empty")
	}
	reason, fix = diagnoseError(nil, "permission denied")
	if reason == "" || fix == "" {
		t.Fatal("permission diagnosis should not be empty")
	}
}
