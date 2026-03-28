package notify

import (
	"strings"
	"testing"
)

func TestFormatHeartbeatMissed(t *testing.T) {
	subject, body := FormatHeartbeatMissed(
		"backup",
		"dead",
		"2026-03-28T10:00:00Z",
		"2026-03-28T10:05:00Z",
		12,
		"2026-03-27T10:00:00Z",
	)
	if !strings.Contains(subject, "backup") {
		t.Fatalf("subject: %q", subject)
	}
	for _, want := range []string{
		"Scheduled run time:",
		"Minutes late (since scheduled run): 12",
		"Ping expected by:",
		"Last ping:",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("body missing %q:\n%s", want, body)
		}
	}
	_, neverBody := FormatHeartbeatMissed("j", "dead", "a", "b", 0, "")
	if !strings.Contains(neverBody, "Last ping: (never)") {
		t.Fatal("expected never ping line")
	}
}
