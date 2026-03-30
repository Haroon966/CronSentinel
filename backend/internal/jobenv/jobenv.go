package jobenv

import (
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

// MaxNameLen is the maximum byte length of an env var name.
const MaxNameLen = 128

// MaxValueRunes is the maximum rune length of a stored value.
const MaxValueRunes = 65536

// MaxVarsPerJob limits how many env rows a job may have.
const MaxVarsPerJob = 64

var (
	nameRe        = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	rePasswordEq  = regexp.MustCompile(`(?i)password\s*=`)
	reAWSKey      = regexp.MustCompile(`(?i)\bAKIA[0-9A-Z]{16}\b`)
	rePrivateKey  = regexp.MustCompile(`(?i)\bBEGIN (RSA |EC |OPENSSH )?PRIVATE KEY`)
)

// ValidateName returns an error message for UI if name is invalid.
func ValidateName(name string) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return errf("name is required")
	}
	if len(name) > MaxNameLen {
		return errf("name is too long")
	}
	if !nameRe.MatchString(name) {
		return errf("name must match [A-Za-z_][A-Za-z0-9_]*")
	}
	return nil
}

func errf(s string) error { return &validationError{s} }

type validationError struct{ msg string }

func (e *validationError) Error() string { return e.msg }

// MaskValue shows only the last four characters of a secret (PRD).
func MaskValue(plain string) string {
	if plain == "" {
		return "****"
	}
	runes := []rune(plain)
	if len(runes) <= 4 {
		return strings.Repeat("*", len(runes))
	}
	tail := string(runes[len(runes)-4:])
	return "****" + tail
}

// HeuristicWarnings flags values that look like secrets (plaintext in UI / crontab anti-pattern).
func HeuristicWarnings(value string) []string {
	v := strings.TrimSpace(value)
	if v == "" {
		return nil
	}
	var w []string
	lower := strings.ToLower(v)
	switch {
	case strings.HasPrefix(v, "sk-") && len(v) > 8:
		w = append(w, "value looks like an API secret prefix (sk-…)")
	case strings.Contains(lower, "bearer "):
		w = append(w, "value contains “Bearer …”; prefer storing only the token part")
	case rePasswordEq.MatchString(v):
		w = append(w, "value looks like password=…")
	case reAWSKey.MatchString(v):
		w = append(w, "value looks like an AWS access key id")
	case rePrivateKey.MatchString(v):
		w = append(w, "value looks like a PEM private key")
	case len(v) >= 40 && isHighEntropyASCII(v):
		w = append(w, "value is long and high-entropy (likely a secret)")
	}
	return w
}

func isHighEntropyASCII(s string) bool {
	if !utf8.ValidString(s) {
		return false
	}
	other, n := 0, 0
	for _, r := range s {
		n++
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '+' || r == '/' || r == '=' || r == '-' || r == '_':
			other++
		default:
			return false
		}
	}
	return n >= 40 && other >= 2
}

// RedactValues replaces exact occurrences of known plaintext values (longest first).
// Values shorter than minLen are skipped.
func RedactValues(s string, values []string, minLen int) string {
	if minLen < 1 {
		minLen = 4
	}
	type pair struct {
		val string
		n   int
	}
	var p []pair
	seen := map[string]struct{}{}
	for _, v := range values {
		v = strings.TrimSpace(v)
		if len(v) < minLen {
			continue
		}
		if _, ok := seen[v]; ok {
			continue
		}
		seen[v] = struct{}{}
		p = append(p, pair{v, len(v)})
	}
	sort.Slice(p, func(i, j int) bool { return p[i].n > p[j].n })
	out := s
	for _, x := range p {
		if x.val == "" {
			continue
		}
		out = strings.ReplaceAll(out, x.val, "[REDACTED]")
	}
	return out
}
