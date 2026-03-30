package systemreport

import (
	"strings"
	"testing"

	"github.com/shirou/gopsutil/v4/cpu"
)

func TestCPUModelFromInfos(t *testing.T) {
	if got := cpuModelFromInfos([]cpu.InfoStat{{ModelName: "  Intel Core i7  "}}); got != "Intel Core i7" {
		t.Fatalf("ModelName: got %q", got)
	}
	got := cpuModelFromInfos([]cpu.InfoStat{{VendorID: "ARM", Family: "8", Model: "0xd42"}})
	if !strings.Contains(got, "ARM") || !strings.Contains(got, "family") {
		t.Fatalf("fallback: got %q", got)
	}
}
