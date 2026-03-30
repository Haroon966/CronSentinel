package main

import (
	"os"
	"path/filepath"
	"strings"
	"time"
)

// normalizeJobPayload validates fields for create/update and returns normalized values.
// On failure errMsg is a short user-facing message suitable for HTTP 400.
func normalizeJobPayload(p *jobPayload) (timezone, workingDir string, grace, successExit int, errMsg string) {
	p.Name = strings.TrimSpace(p.Name)
	if p.Name == "" {
		return "", "", 0, 0, "job name is required"
	}
	p.Command = strings.TrimSpace(p.Command)
	if p.Command == "" {
		return "", "", 0, 0, "command is required"
	}
	if !isLikelyCron(p.Schedule) {
		return "", "", 0, 0, "invalid cron schedule — must be exactly 5 space-separated fields"
	}
	if p.TimeoutSeconds < 0 || p.TimeoutSeconds > 604800 {
		return "", "", 0, 0, "timeout_seconds must be between 0 (disabled) and 604800"
	}
	grace = p.HeartbeatGraceSeconds
	if grace <= 0 {
		grace = 300
	}
	if grace > 604800 {
		grace = 604800
	}
	successExit = p.SuccessExitCode
	if successExit < 0 || successExit > 255 {
		return "", "", 0, 0, "success_exit_code must be between 0 and 255"
	}
	timezone = strings.TrimSpace(p.Timezone)
	if timezone == "" {
		timezone = "Local"
	}
	if timezone != "Local" {
		if _, err := time.LoadLocation(timezone); err != nil {
			return "", "", 0, 0, "invalid timezone"
		}
	}
	workingDir = strings.TrimSpace(p.WorkingDir)
	if workingDir != "" {
		if !filepath.IsAbs(workingDir) {
			return "", "", 0, 0, "working_directory must be an absolute path"
		}
		info, err := os.Stat(workingDir)
		if err != nil || !info.IsDir() {
			return "", "", 0, 0, "working_directory does not exist or is not a directory"
		}
	}
	return timezone, workingDir, grace, successExit, ""
}
