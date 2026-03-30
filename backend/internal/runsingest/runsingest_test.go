package runsingest

import (
	"strings"
	"testing"
	"time"
)

func TestTruncateUTF8(t *testing.T) {
	s, tr := TruncateUTF8("hello", 10)
	if s != "hello" || tr {
		t.Fatalf("short string: %q %v", s, tr)
	}
	long := strings.Repeat("a", MaxLogBytes+100)
	s, tr = TruncateUTF8(long, MaxLogBytes)
	if len(s) > MaxLogBytes || !tr {
		t.Fatalf("truncate len=%d tr=%v", len(s), tr)
	}
}

func TestNormalize(t *testing.T) {
	now := time.Date(2026, 3, 28, 12, 0, 0, 0, time.UTC)
	p := IngestPayload{
		ExitCode:   0,
		Stdout:     "ok",
		Stderr:     "",
		DurationMs: 1500,
		StartedAt:  "2026-03-28T11:58:30Z",
	}
	n, err := Normalize(p, now)
	if err != nil {
		t.Fatal(err)
	}
	if n.DurationMs != 1500 || n.ExitCode != 0 || n.Stdout != "ok" {
		t.Fatalf("%+v", n)
	}
	if !n.EndedAt.Equal(n.StartedAt.Add(1500 * time.Millisecond)) {
		t.Fatalf("ended %v start %v", n.EndedAt, n.StartedAt)
	}
}

func TestNormalizeFutureStarted(t *testing.T) {
	now := time.Date(2026, 3, 28, 12, 0, 0, 0, time.UTC)
	p := IngestPayload{StartedAt: "2099-01-01T00:00:00Z", DurationMs: 1, ExitCode: 0}
	_, err := Normalize(p, now)
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestNormalizeNegativeDuration(t *testing.T) {
	now := time.Now()
	_, err := Normalize(IngestPayload{ExitCode: 0, DurationMs: -1, StartedAt: now.UTC().Format(time.RFC3339)}, now)
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestStatusForExit(t *testing.T) {
	if StatusForExit(0, 0) != "success" {
		t.Fatal()
	}
	if StatusForExit(1, 0) != "failure" {
		t.Fatal()
	}
	if StatusForExit(5, 5) != "success" {
		t.Fatal()
	}
}
