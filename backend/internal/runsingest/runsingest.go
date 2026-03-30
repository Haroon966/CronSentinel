// Package runsingest validates and normalizes external agent run payloads.
package runsingest

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

// MaxLogBytes is the maximum stored size per stdout/stderr stream (PRD: 1MB).
const MaxLogBytes = 1024 * 1024

// MaxBodyBytes is the maximum accepted JSON body size (~2 streams + overhead).
const MaxBodyBytes = 2*MaxLogBytes + 65536

// IngestPayload is the JSON body for POST /api/jobs/:id/runs.
type IngestPayload struct {
	ExitCode   int    `json:"exit_code"`
	Stdout     string `json:"stdout"`
	Stderr     string `json:"stderr"`
	DurationMs int    `json:"duration_ms"`
	StartedAt  string `json:"started_at"`
}

// Normalized holds validated fields ready for persistence.
type Normalized struct {
	ExitCode         int
	Stdout           string
	Stderr           string
	DurationMs       int
	StartedAt        time.Time
	EndedAt          time.Time
	StdoutTruncated  bool
	StderrTruncated  bool
}

// TruncateUTF8 returns s truncated to at most maxBytes UTF-8 octets and whether truncation occurred.
func TruncateUTF8(s string, maxBytes int) (out string, truncated bool) {
	if maxBytes <= 0 {
		return "", len(s) > 0
	}
	if len(s) <= maxBytes {
		return s, false
	}
	out = s[:maxBytes]
	for len(out) > 0 && !utf8.ValidString(out) {
		out = out[:len(out)-1]
	}
	return out, true
}

// Normalize validates payload and applies log size limits.
func Normalize(p IngestPayload, now time.Time) (Normalized, error) {
	var z Normalized
	if p.DurationMs < 0 {
		return z, fmt.Errorf("duration_ms must be >= 0")
	}
	started, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(p.StartedAt))
	if err != nil {
		started, err = time.Parse(time.RFC3339, strings.TrimSpace(p.StartedAt))
	}
	if err != nil {
		return z, fmt.Errorf("started_at must be RFC3339")
	}
	// Reject unreasonably future timestamps (clock skew allowance ~24h)
	if started.After(now.Add(24 * time.Hour)) {
		return z, fmt.Errorf("started_at is too far in the future")
	}
	z.StartedAt = started.UTC()
	z.DurationMs = p.DurationMs
	z.EndedAt = z.StartedAt.Add(time.Duration(p.DurationMs) * time.Millisecond)

	z.Stdout, z.StdoutTruncated = TruncateUTF8(p.Stdout, MaxLogBytes)
	z.Stderr, z.StderrTruncated = TruncateUTF8(p.Stderr, MaxLogBytes)
	z.ExitCode = p.ExitCode
	return z, nil
}

// StatusForExit returns success or failure comparing exit code to configured success code.
func StatusForExit(exitCode, successExitCode int) string {
	if exitCode == successExitCode {
		return "success"
	}
	return "failure"
}
