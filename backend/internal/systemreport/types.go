package systemreport

// Report is the stable JSON contract for GET /api/system.
type Report struct {
	UptimeSeconds uint64       `json:"uptime_seconds"`
	CPUCount      int          `json:"cpu_count"`
	Host          HostReport   `json:"host"`
	CPU           CPUReport    `json:"cpu"`
	Memory        MemReport    `json:"memory"`
	Swap          MemReport    `json:"swap"`
	Load          LoadReport   `json:"load"`
	Disks         []DiskReport `json:"disks"`
	Network       []NetReport  `json:"network"`
	GPU           GPUReport    `json:"gpu"`
	Errors        []string     `json:"errors,omitempty"`
}

// HostReport is auto-detected via gopsutil host.Info().
type HostReport struct {
	Hostname             string `json:"hostname"`
	OS                   string `json:"os"`
	Platform             string `json:"platform"`
	PlatformFamily       string `json:"platform_family"`
	PlatformVersion      string `json:"platform_version"`
	KernelVersion        string `json:"kernel_version"`
	KernelArch           string `json:"kernel_arch"`
	BootTimeUnix         uint64 `json:"boot_time_unix"`
	VirtualizationSystem string `json:"virtualization_system,omitempty"`
	VirtualizationRole   string `json:"virtualization_role,omitempty"`
}

// CPUReport is derived from gopsutil cpu.Info and cpu.Counts.
type CPUReport struct {
	ModelName     string  `json:"model_name"`
	LogicalCores  int     `json:"logical_cores"`
	PhysicalCores int     `json:"physical_cores"`
	MhzMax        float64 `json:"mhz_max,omitempty"`
}

// MemReport maps RAM or swap usage (bytes + percent).
type MemReport struct {
	Total       uint64  `json:"total"`
	Used        uint64  `json:"used"`
	Free        uint64  `json:"free"`
	UsedPercent float64 `json:"used_percent"`
}

// LoadReport is system load average.
type LoadReport struct {
	Load1  float64 `json:"load1"`
	Load5  float64 `json:"load5"`
	Load15 float64 `json:"load15"`
}

// DiskReport is one mounted filesystem.
type DiskReport struct {
	Path        string  `json:"path"`
	Fstype      string  `json:"fstype"`
	Total       uint64  `json:"total"`
	Used        uint64  `json:"used"`
	Free        uint64  `json:"free"`
	UsedPercent float64 `json:"used_percent"`
}

// NetReport is per-interface counters from gopsutil (loopback omitted).
type NetReport struct {
	Name        string `json:"name"`
	BytesSent   uint64 `json:"bytes_sent"`
	BytesRecv   uint64 `json:"bytes_recv"`
	PacketsSent uint64 `json:"packets_sent"`
	PacketsRecv uint64 `json:"packets_recv"`
}

// GPUDevice is one detected GPU.
type GPUDevice struct {
	Name   string `json:"name"`
	Vendor string `json:"vendor,omitempty"`
	Driver string `json:"driver,omitempty"`
}

// GPUReport is either detected devices or unavailable with reason.
type GPUReport struct {
	Status  string      `json:"status"`
	Reason  string      `json:"reason,omitempty"`
	Devices []GPUDevice `json:"devices,omitempty"`
}
