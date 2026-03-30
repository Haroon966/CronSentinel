package systemreport

import (
	"log/slog"
	"strings"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/load"
	"github.com/shirou/gopsutil/v4/mem"
	"github.com/shirou/gopsutil/v4/net"
)

// cpuModelFromInfos prefers ModelName; falls back to vendor/family/model when the OS leaves ModelName empty (common on some ARM/VM images).
func cpuModelFromInfos(infos []cpu.InfoStat) string {
	for _, info := range infos {
		if s := strings.TrimSpace(info.ModelName); s != "" {
			return s
		}
	}
	if len(infos) == 0 {
		return ""
	}
	info := infos[0]
	var parts []string
	if s := strings.TrimSpace(info.VendorID); s != "" {
		parts = append(parts, s)
	}
	if s := strings.TrimSpace(info.Family); s != "" {
		parts = append(parts, "family "+s)
	}
	if s := strings.TrimSpace(info.Model); s != "" {
		parts = append(parts, "model "+s)
	}
	if len(parts) > 0 {
		return strings.Join(parts, " · ")
	}
	return ""
}

// Build collects auto-detected system information. Individual probe failures are recorded in Errors; the report is still returned.
func Build() Report {
	var errs []string
	r := Report{
		GPU: DetectGPU(),
	}

	up, err := host.Uptime()
	if err != nil {
		errs = append(errs, "uptime: "+err.Error())
	} else {
		r.UptimeSeconds = up
	}

	hi, err := host.Info()
	if err != nil {
		errs = append(errs, "host: "+err.Error())
	} else {
		r.Host = HostReport{
			Hostname:             hi.Hostname,
			OS:                   hi.OS,
			Platform:             hi.Platform,
			PlatformFamily:       hi.PlatformFamily,
			PlatformVersion:      hi.PlatformVersion,
			KernelVersion:        hi.KernelVersion,
			KernelArch:           hi.KernelArch,
			BootTimeUnix:         hi.BootTime,
			VirtualizationSystem: hi.VirtualizationSystem,
			VirtualizationRole:   hi.VirtualizationRole,
		}
	}
	// Fill gaps when host.Info fails or returns empty (typical in Docker/Alpine).
	enrichHost(&r.Host, r.UptimeSeconds)

	logical, err := cpu.Counts(true)
	if err != nil {
		errs = append(errs, "cpu counts: "+err.Error())
		logical = 0
	}
	physical, err := cpu.Counts(false)
	if err != nil {
		errs = append(errs, "cpu physical count: "+err.Error())
		physical = 0
	}
	infos, err := cpu.Info()
	if err != nil {
		errs = append(errs, "cpu info: "+err.Error())
	}
	var mhzMax float64
	seenPhys := make(map[string]struct{})
	for _, info := range infos {
		if info.Mhz > mhzMax {
			mhzMax = info.Mhz
		}
		key := info.PhysicalID + "/" + info.CoreID
		if key != "/" {
			seenPhys[key] = struct{}{}
		}
	}
	model := cpuModelFromInfos(infos)
	if model == "" {
		model = procCPUModelName()
	}
	physCores := physical
	if physCores == 0 && len(seenPhys) > 0 {
		physCores = len(seenPhys)
	}
	r.CPU = CPUReport{
		ModelName:     model,
		LogicalCores:  logical,
		PhysicalCores: physCores,
		MhzMax:        mhzMax,
	}
	r.CPUCount = logical

	vm, err := mem.VirtualMemory()
	if err != nil {
		errs = append(errs, "memory: "+err.Error())
	} else {
		r.Memory = MemReport{
			Total:       vm.Total,
			Used:        vm.Used,
			Free:        vm.Free,
			UsedPercent: vm.UsedPercent,
		}
	}

	sw, err := mem.SwapMemory()
	if err != nil {
		errs = append(errs, "swap: "+err.Error())
	} else {
		r.Swap = MemReport{
			Total:       sw.Total,
			Used:        sw.Used,
			Free:        sw.Free,
			UsedPercent: sw.UsedPercent,
		}
	}

	ld, err := load.Avg()
	if err != nil {
		errs = append(errs, "load: "+err.Error())
	} else {
		r.Load = LoadReport{Load1: ld.Load1, Load5: ld.Load5, Load15: ld.Load15}
	}

	r.Disks = collectDisks(&errs)
	r.Network = collectNetwork(&errs)

	if len(errs) > 0 {
		r.Errors = errs
		slog.Debug("systemreport partial errors", "errors", errs)
	}
	return r
}

func collectDisks(errs *[]string) []DiskReport {
	parts, err := disk.Partitions(false)
	if err != nil {
		*errs = append(*errs, "disk partitions: "+err.Error())
		return nil
	}
	seen := make(map[string]struct{})
	var out []DiskReport
	for _, p := range parts {
		mp := p.Mountpoint
		if mp == "" {
			continue
		}
		if _, dup := seen[mp]; dup {
			continue
		}
		usage, err := disk.Usage(mp)
		if err != nil {
			continue
		}
		seen[mp] = struct{}{}
		out = append(out, DiskReport{
			Path:        mp,
			Fstype:      p.Fstype,
			Total:       usage.Total,
			Used:        usage.Used,
			Free:        usage.Free,
			UsedPercent: usage.UsedPercent,
		})
	}
	return out
}

func collectNetwork(errs *[]string) []NetReport {
	counters, err := net.IOCounters(false)
	if err != nil {
		*errs = append(*errs, "network: "+err.Error())
		return nil
	}
	var out []NetReport
	for _, c := range counters {
		if c.Name == "lo" {
			continue
		}
		out = append(out, NetReport{
			Name:        c.Name,
			BytesSent:   c.BytesSent,
			BytesRecv:   c.BytesRecv,
			PacketsSent: c.PacketsSent,
			PacketsRecv: c.PacketsRecv,
		})
	}
	return out
}
