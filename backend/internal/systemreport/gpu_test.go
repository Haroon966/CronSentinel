package systemreport

import (
	"strings"
	"testing"
)

func TestParseNvidiaSMIList(t *testing.T) {
	sample := `GPU 0: NVIDIA GeForce RTX 3080 (UUID: GPU-abc)
GPU 1: NVIDIA GeForce RTX 2070 (UUID: GPU-def)
`
	devices := parseNvidiaSMIList([]byte(sample))
	if len(devices) != 2 {
		t.Fatalf("got %d devices, want 2", len(devices))
	}
	if devices[0].Name != "NVIDIA GeForce RTX 3080" {
		t.Errorf("device 0 name: %q", devices[0].Name)
	}
	if !strings.Contains(devices[1].Name, "2070") {
		t.Errorf("device 1 name: %q", devices[1].Name)
	}
}
