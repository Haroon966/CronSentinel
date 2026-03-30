package linediff

import (
	"strings"
	"testing"
)

func TestUnified_addAndRemove(t *testing.T) {
	old := "a\nb\nc\n"
	new := "a\nx\nc\n"
	d := Unified(old, new)
	if !strings.Contains(d, "- b") || !strings.Contains(d, "+ x") {
		t.Fatalf("expected remove b and add x, got:\n%s", d)
	}
}

func TestUnified_empty(t *testing.T) {
	if Unified("", "") != "" {
		t.Fatal("two empty should be empty")
	}
	if !strings.Contains(Unified("a\n", ""), "- a") {
		t.Fatal("expected removal of a")
	}
	if !strings.Contains(Unified("", "z\n"), "+ z") {
		t.Fatal("expected addition of z")
	}
}
