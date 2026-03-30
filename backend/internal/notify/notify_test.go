package notify

import (
	"strings"
	"testing"
)

func TestShouldNotifyRunTimedOut(t *testing.T) {
	s := &Settings{Enabled: true, NotifyScheduledFailure: true}
	if !ShouldNotifyRun(s, "scheduled", "timed_out") {
		t.Fatal("scheduled timed_out should follow scheduled failure toggle")
	}
	s2 := &Settings{Enabled: true, NotifyManualFailure: true}
	if !ShouldNotifyRun(s2, "manual", "timed_out") {
		t.Fatal("manual timed_out should follow manual failure toggle")
	}
	if ShouldNotifyRun(s, "ingest", "timed_out") {
		t.Fatal("ingest trigger should not send run email")
	}
}

func TestFormatRunCompletedTimedOut(t *testing.T) {
	sub, body := FormatRunCompleted("job1", "cmd", "timed_out", "rid", nil,
		"Run exceeded configured timeout of 42 seconds (duration at timeout: 42000 ms)", "", "")
	if !strings.Contains(sub, "Timed out") || !strings.Contains(sub, "job1") {
		t.Fatalf("subject: %q", sub)
	}
	if !strings.Contains(body, "job execution timeout") || !strings.Contains(body, "42 seconds") {
		t.Fatalf("body: %s", body)
	}
	if !strings.Contains(body, "Timeout detail:") {
		t.Fatal("expected timeout detail label")
	}
}

func TestFormatServerUnreachable(t *testing.T) {
	sub, body := FormatServerUnreachable("prod-db", "2026-03-29T12:00:00Z", 5)
	if !strings.Contains(sub, "Server unreachable") || !strings.Contains(sub, "prod-db") {
		t.Fatalf("subject: %q", sub)
	}
	if !strings.Contains(body, "server heartbeat") || !strings.Contains(body, "Minutes since last ping: 5") {
		t.Fatalf("body: %s", body)
	}
	if strings.Contains(body, "scheduled run") {
		t.Fatal("body should not reuse job heartbeat wording")
	}
	sub2, body2 := FormatServerUnreachable("edge", "", 12)
	if !strings.Contains(body2, "never") || !strings.Contains(body2, "12") {
		t.Fatalf("never-seen body: %s", body2)
	}
	_ = sub2
}

func TestFormatCrontabChanged(t *testing.T) {
	sub, body := FormatCrontabChanged("web-1", "root", "- old\n+ new")
	if !strings.Contains(sub, "Crontab changed") || !strings.Contains(body, "crontab snapshot") {
		t.Fatalf("unexpected format: %s / %s", sub, body)
	}
	if !strings.Contains(body, "- old") {
		t.Fatal("expected diff in body")
	}
}
