package systemreport

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

const nvidiaSMITimeout = 2 * time.Second

var nvidiaListLine = regexp.MustCompile(`(?i)^GPU\s+\d+:\s*(.+?)\s*\(UUID:`)

// DetectGPU returns GPU devices from Linux DRM sysfs and/or nvidia-smi. Never panics.
func DetectGPU() GPUReport {
	if runtime.GOOS != "linux" {
		devices := tryNvidiaSMI()
		if len(devices) > 0 {
			return GPUReport{Status: "ok", Devices: devices}
		}
		return GPUReport{Status: "unavailable", Reason: "GPU detection on " + runtime.GOOS + " is limited; no devices found"}
	}

	var devices []GPUDevice
	devices = append(devices, detectDRMDevices()...)
	devices = append(devices, tryNvidiaSMI()...)
	devices = dedupeGPUDevices(devices)

	if len(devices) > 0 {
		return GPUReport{Status: "ok", Devices: devices}
	}
	return GPUReport{Status: "unavailable", Reason: "no GPU exposed to this environment (common in minimal or container images)"}
}

func dedupeGPUDevices(devices []GPUDevice) []GPUDevice {
	seen := make(map[string]struct{})
	var out []GPUDevice
	for _, d := range devices {
		key := d.Name + "\x00" + d.Driver + "\x00" + d.Vendor
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, d)
	}
	return out
}

func detectDRMDevices() []GPUDevice {
	matches, err := filepath.Glob("/sys/class/drm/card[0-9]")
	if err != nil || len(matches) == 0 {
		return nil
	}
	var out []GPUDevice
	for _, cardDir := range matches {
		devDir := filepath.Join(cardDir, "device")
		st, err := os.Stat(devDir)
		if err != nil || !st.IsDir() {
			continue
		}
		vendor := strings.TrimSpace(readFirstLine(filepath.Join(devDir, "vendor")))
		device := strings.TrimSpace(readFirstLine(filepath.Join(devDir, "device")))
		driver := parseUeventDriver(filepath.Join(devDir, "uevent"))
		if vendor == "" && device == "" && driver == "" {
			continue
		}
		name := strings.TrimSpace(readFirstLine(filepath.Join(devDir, "product_name")))
		if name == "" {
			name = strings.TrimSpace(readFirstLine(filepath.Join(devDir, "label")))
		}
		if name == "" {
			name = "Display adapter"
			if driver != "" {
				name = name + " (" + driver + ")"
			}
		}
		v := ""
		if vendor != "" || device != "" {
			v = strings.TrimSpace(vendor + " " + device)
		}
		out = append(out, GPUDevice{Name: name, Vendor: v, Driver: driver})
	}
	return out
}

func readFirstLine(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	s := strings.TrimSpace(string(b))
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	return strings.TrimSpace(s)
}

func parseUeventDriver(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "DRIVER=") {
			return strings.TrimSpace(strings.TrimPrefix(line, "DRIVER="))
		}
	}
	return ""
}

func tryNvidiaSMI() []GPUDevice {
	path, err := exec.LookPath("nvidia-smi")
	if err != nil || path == "" {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), nvidiaSMITimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "-L")
	out, err := cmd.Output()
	if err != nil || len(out) == 0 {
		return nil
	}
	return parseNvidiaSMIList(out)
}

func parseNvidiaSMIList(out []byte) []GPUDevice {
	var devices []GPUDevice
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if m := nvidiaListLine.FindStringSubmatch(line); len(m) == 2 {
			name := strings.TrimSpace(m[1])
			if name != "" {
				devices = append(devices, GPUDevice{Name: name, Vendor: "NVIDIA", Driver: "nvidia"})
			}
		}
	}
	return devices
}
