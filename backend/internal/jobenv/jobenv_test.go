package jobenv

import "testing"

func TestRedactValues(t *testing.T) {
	s := "prefix MYSECRET suffix"
	got := RedactValues(s, []string{"MYSECRET", "unused"}, 4)
	want := "prefix [REDACTED] suffix"
	if got != want {
		t.Fatalf("want %q got %q", want, got)
	}
}

func TestRedactValuesLongestFirst(t *testing.T) {
	s := "aa bb aabb"
	got := RedactValues(s, []string{"aa", "aabb"}, 2)
	// Longest "aabb" first -> "aa bb [REDACTED]"; then "aa" at start -> "[REDACTED] bb [REDACTED]"
	want := "[REDACTED] bb [REDACTED]"
	if got != want {
		t.Fatalf("want %q got %q", want, got)
	}
}

func TestMaskValue(t *testing.T) {
	if MaskValue("ab") != "**" {
		t.Fatalf("short: %q", MaskValue("ab"))
	}
	if MaskValue("abcdef") != "****ef" {
		t.Fatalf("long: %q", MaskValue("abcdef"))
	}
}

func TestValidateName(t *testing.T) {
	if ValidateName("OK_NAME") != nil {
		t.Fatal(ValidateName("OK_NAME"))
	}
	if ValidateName("0bad") == nil {
		t.Fatal("expected error")
	}
	if ValidateName("") == nil {
		t.Fatal("expected error")
	}
}
