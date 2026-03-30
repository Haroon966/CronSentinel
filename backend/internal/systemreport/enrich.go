package systemreport

import (
	"bufio"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// enrichHost fills missing host.* fields when gopsutil host.Info fails or returns
// empty strings — common in minimal Docker images (Alpine) or static binaries.
func enrichHost(h *HostReport, uptimeSec uint64) {
	if h.Hostname == "" {
		if hn, err := os.Hostname(); err == nil && strings.TrimSpace(hn) != "" {
			h.Hostname = strings.TrimSpace(hn)
		}
	}
	if h.OS == "" {
		h.OS = goosToOS(runtime.GOOS)
	}
	if h.KernelArch == "" {
		h.KernelArch = runtime.GOARCH
	}
	if h.KernelVersion == "" {
		if b, err := os.ReadFile("/proc/sys/kernel/osrelease"); err == nil {
			h.KernelVersion = strings.TrimSpace(string(b))
		}
	}
	id, ver, pretty, fam := parseOSRelease()
	if h.Platform == "" {
		if pretty != "" {
			h.Platform = pretty
		} else if id != "" {
			h.Platform = id
		}
	}
	// Avoid duplicating version when PRETTY_NAME already includes it (e.g. "Alpine Linux v3.20").
	if h.PlatformVersion == "" && ver != "" && pretty == "" {
		h.PlatformVersion = ver
	}
	if h.PlatformFamily == "" && fam != "" {
		h.PlatformFamily = fam
	}
	if h.BootTimeUnix == 0 && uptimeSec > 0 {
		if bt := bootTimeFromProcStat(); bt > 0 {
			h.BootTimeUnix = bt
		} else {
			h.BootTimeUnix = uint64(time.Now().Unix()) - uptimeSec
		}
	}
	if h.VirtualizationSystem == "" {
		if _, err := os.Stat("/.dockerenv"); err == nil {
			h.VirtualizationSystem = "docker"
			if h.VirtualizationRole == "" {
				h.VirtualizationRole = "guest"
			}
		}
	}
}

func goosToOS(goos string) string {
	switch goos {
	case "windows":
		return "windows"
	case "darwin":
		return "darwin"
	default:
		return "linux"
	}
}

// parseOSRelease reads /etc/os-release (ID, VERSION_ID, PRETTY_NAME, ID_LIKE).
func parseOSRelease() (id, version, pretty, family string) {
	b, err := os.ReadFile("/etc/os-release")
	if err != nil {
		return "", "", "", ""
	}
	lines := strings.Split(string(b), "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		v = strings.TrimSpace(v)
		if len(v) >= 2 && ((v[0] == '"' && v[len(v)-1] == '"') || (v[0] == '\'' && v[len(v)-1] == '\'')) {
			v = v[1 : len(v)-1]
		}
		switch k {
		case "ID":
			id = v
		case "VERSION_ID":
			version = v
		case "PRETTY_NAME":
			pretty = v
		case "ID_LIKE":
			family = v
		}
	}
	return id, version, pretty, family
}

func bootTimeFromProcStat() uint64 {
	b, err := os.ReadFile("/proc/stat")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, "btime ") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				sec, err := strconv.ParseUint(fields[1], 10, 64)
				if err == nil {
					return sec
				}
			}
			return 0
		}
	}
	return 0
}

// procCPUModelName reads the first useful CPU description from /proc/cpuinfo
// when gopsutil leaves ModelName empty (seen in some containers).
func procCPUModelName() string {
	f, err := os.Open("/proc/cpuinfo")
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), ":")
		if !ok {
			continue
		}
		key := strings.TrimSpace(k)
		val := strings.TrimSpace(v)
		if val == "" {
			continue
		}
		switch key {
		case "model name", "Hardware", "cpu model", "Processor":
			return val
		}
	}
	return ""
}
