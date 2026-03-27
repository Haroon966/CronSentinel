package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/load"
	"github.com/shirou/gopsutil/v4/mem"
	"github.com/shirou/gopsutil/v4/net"
)

type app struct {
	db          *pgxpool.Pool
	scriptDir   string
	subscribers map[string][]chan string
	lastTickRun map[string]time.Time
	mu          sync.Mutex
}

type scriptPayload struct {
	Name    string `json:"name"`
	Content string `json:"content"`
}

type jobPayload struct {
	Name           string `json:"name"`
	Schedule       string `json:"schedule"`
	WorkingDir     string `json:"working_directory"`
	Command        string `json:"command"`
	Comment        string `json:"comment"`
	LoggingEnabled bool   `json:"logging_enabled"`
	TimeoutSeconds int    `json:"timeout_seconds"`
}

var scriptNameRe = regexp.MustCompile(`^[a-zA-Z0-9._-]+$`)

func main() {
	ctx := context.Background()
	dbURL := envOr("DATABASE_URL", "postgres://postgres:postgres@db:5432/cronsentinel?sslmode=disable")
	port := envOr("PORT", "8080")
	scriptDir := envOr("SCRIPT_DIR", "/data/scripts")

	if err := os.MkdirAll(scriptDir, 0o755); err != nil {
		slog.Error("failed to create script dir", "err", err)
		os.Exit(1)
	}

	db, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		slog.Error("failed to build db pool", "err", err)
		os.Exit(1)
	}
	defer db.Close()

	// Retry DB connection until ready (docker healthcheck should handle this,
	// but we add our own retry as a second safety net).
	if err := waitForDB(ctx, db, 15, 2*time.Second); err != nil {
		slog.Error("database never became ready", "err", err)
		os.Exit(1)
	}

	a := &app{
		db:          db,
		scriptDir:   scriptDir,
		subscribers: make(map[string][]chan string),
		lastTickRun: make(map[string]time.Time),
	}
	if err := a.ensureSchema(ctx); err != nil {
		slog.Error("failed to apply schema", "err", err)
		os.Exit(1)
	}

	go a.schedulerLoop(context.Background())
	go a.cleanupLoop(context.Background(), 7*24*time.Hour)

	r := gin.Default()
	r.Use(cors.Default())

	r.GET("/healthz", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) })
	r.GET("/api/system", a.systemInfo)
	r.GET("/api/scripts", a.listScripts)
	r.POST("/api/scripts", a.createScript)
	r.DELETE("/api/scripts/:name", a.deleteScript)

	r.GET("/api/jobs", a.listJobs)
	r.GET("/api/jobs/presets", a.jobPresets)
	r.POST("/api/jobs", a.createJob)
	r.DELETE("/api/jobs/:id", a.deleteJob)
	r.POST("/api/jobs/:id/run", a.runJobManual)
	r.GET("/api/runs", a.listRuns)
	r.GET("/api/runs/:id/logs", a.getRunLogs)
	r.GET("/api/runs/:id/stream", a.streamRun)

	slog.Info("server starting", "port", port)
	if err := r.Run(":" + port); err != nil {
		slog.Error("server failed", "err", err)
		os.Exit(1)
	}
}

// waitForDB pings the database up to maxAttempts times with the given interval.
func waitForDB(ctx context.Context, db *pgxpool.Pool, maxAttempts int, interval time.Duration) error {
	for i := range maxAttempts {
		if err := db.Ping(ctx); err == nil {
			slog.Info("database ready", "attempt", i+1)
			return nil
		}
		slog.Warn("database not ready", "attempt", i+1, "max", maxAttempts)
		// Skip sleep after the last attempt — we're about to give up.
		if i < maxAttempts-1 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(interval):
			}
		}
	}
	return fmt.Errorf("database did not become ready after %d attempts", maxAttempts)
}

func (a *app) ensureSchema(ctx context.Context) error {
	schema := `
create table if not exists scripts (
  id uuid primary key,
  name text unique not null,
  content text not null,
  created_at timestamptz not null default now()
);
create table if not exists cron_jobs (
  id uuid primary key,
  name text not null,
  schedule text not null,
  working_dir text not null default '',
  command text not null,
  comment text not null default '',
  logging_enabled boolean not null default true,
  timeout_seconds int not null default 300,
  created_at timestamptz not null default now()
);
create table if not exists job_runs (
  id uuid primary key,
  job_id uuid references cron_jobs(id) on delete set null,
  job_name text not null,
  command text not null,
  status text not null,
  exit_code int,
  stdout text not null default '',
  stderr text not null default '',
  started_at timestamptz not null,
  ended_at timestamptz,
  failure_reason text not null default '',
  failure_fix text not null default ''
);`
	if _, err := a.db.Exec(ctx, schema); err != nil {
		return fmt.Errorf("create tables: %w", err)
	}
	if _, err := a.db.Exec(ctx, "alter table cron_jobs add column if not exists working_dir text not null default ''"); err != nil {
		return fmt.Errorf("migrate working_dir: %w", err)
	}
	return nil
}

func (a *app) listScripts(c *gin.Context) {
	rows, err := a.db.Query(c, "select name, content, created_at from scripts order by created_at desc")
	if err != nil {
		slog.Error("listScripts query", "err", err)
		c.JSON(500, gin.H{"error": "failed to query scripts"})
		return
	}
	defer rows.Close()

	out := make([]gin.H, 0)
	for rows.Next() {
		var name, content string
		var created time.Time
		if err := rows.Scan(&name, &content, &created); err != nil {
			slog.Error("listScripts scan", "err", err)
			c.JSON(500, gin.H{"error": "failed to read script row"})
			return
		}
		out = append(out, gin.H{"name": name, "content": content, "created_at": created})
	}
	if err := rows.Err(); err != nil {
		slog.Error("listScripts rows", "err", err)
		c.JSON(500, gin.H{"error": "error iterating scripts"})
		return
	}
	c.JSON(200, out)
}

func (a *app) createScript(c *gin.Context) {
	var p scriptPayload
	if err := c.BindJSON(&p); err != nil {
		c.JSON(400, gin.H{"error": "invalid JSON payload"})
		return
	}
	p.Name = strings.TrimSpace(p.Name)
	if p.Name == "" {
		c.JSON(400, gin.H{"error": "script name is required"})
		return
	}
	if !scriptNameRe.MatchString(p.Name) {
		c.JSON(400, gin.H{"error": "script name must only contain letters, digits, dots, hyphens, or underscores"})
		return
	}
	if strings.TrimSpace(p.Content) == "" {
		c.JSON(400, gin.H{"error": "script content is required"})
		return
	}

	filePath := fmt.Sprintf("%s/%s.sh", a.scriptDir, p.Name)
	content := "#!/usr/bin/env bash\nset -e\n" + p.Content + "\n"
	if err := os.WriteFile(filePath, []byte(content), 0o755); err != nil {
		slog.Error("createScript write file", "path", filePath, "err", err)
		c.JSON(500, gin.H{"error": "failed to write script file"})
		return
	}

	_, dbErr := a.db.Exec(c,
		"insert into scripts(id,name,content) values($1,$2,$3) on conflict (name) do update set content=excluded.content",
		uuid.New(), p.Name, content,
	)
	if dbErr != nil {
		// Roll back the file so disk and DB stay in sync.
		if rmErr := os.Remove(filePath); rmErr != nil {
			slog.Error("createScript rollback file", "path", filePath, "err", rmErr)
		}
		slog.Error("createScript db insert", "err", dbErr)
		c.JSON(500, gin.H{"error": "failed to save script to database"})
		return
	}
	c.JSON(201, gin.H{"ok": true})
}

func (a *app) deleteScript(c *gin.Context) {
	name := c.Param("name")
	if _, err := a.db.Exec(c, "delete from scripts where name=$1", name); err != nil {
		slog.Error("deleteScript db", "name", name, "err", err)
		c.JSON(500, gin.H{"error": "failed to delete script from database"})
		return
	}
	filePath := fmt.Sprintf("%s/%s.sh", a.scriptDir, name)
	if err := os.Remove(filePath); err != nil && !os.IsNotExist(err) {
		slog.Warn("deleteScript file removal", "path", filePath, "err", err)
		// Non-fatal: DB row is gone; log and continue.
	}
	c.JSON(200, gin.H{"ok": true})
}

func (a *app) listJobs(c *gin.Context) {
	rows, err := a.db.Query(c,
		"select id,name,schedule,working_dir,command,comment,logging_enabled,timeout_seconds,created_at from cron_jobs order by created_at desc")
	if err != nil {
		slog.Error("listJobs query", "err", err)
		c.JSON(500, gin.H{"error": "failed to query jobs"})
		return
	}
	defer rows.Close()

	out := make([]gin.H, 0)
	for rows.Next() {
		var id uuid.UUID
		var name, schedule, workingDir, cmd, comment string
		var logEnabled bool
		var timeout int
		var created time.Time
		if err := rows.Scan(&id, &name, &schedule, &workingDir, &cmd, &comment, &logEnabled, &timeout, &created); err != nil {
			slog.Error("listJobs scan", "err", err)
			c.JSON(500, gin.H{"error": "failed to read job row"})
			return
		}
		out = append(out, gin.H{
			"id": id, "name": name, "schedule": schedule, "working_directory": workingDir,
			"command": cmd, "comment": comment, "logging_enabled": logEnabled,
			"timeout_seconds": timeout, "created_at": created,
		})
	}
	if err := rows.Err(); err != nil {
		slog.Error("listJobs rows", "err", err)
		c.JSON(500, gin.H{"error": "error iterating jobs"})
		return
	}
	c.JSON(200, out)
}

func (a *app) jobPresets(c *gin.Context) {
	c.JSON(200, []gin.H{
		{"label": "Every minute", "schedule": "* * * * *"},
		{"label": "Every 5 minutes", "schedule": "*/5 * * * *"},
		{"label": "Hourly", "schedule": "0 * * * *"},
		{"label": "Daily at midnight", "schedule": "0 0 * * *"},
		{"label": "Weekly (Sunday midnight)", "schedule": "0 0 * * 0"},
	})
}

func (a *app) createJob(c *gin.Context) {
	var p jobPayload
	if err := c.BindJSON(&p); err != nil {
		c.JSON(400, gin.H{"error": "invalid JSON payload"})
		return
	}
	p.Name = strings.TrimSpace(p.Name)
	if p.Name == "" {
		c.JSON(400, gin.H{"error": "job name is required"})
		return
	}
	p.Command = strings.TrimSpace(p.Command)
	if p.Command == "" {
		c.JSON(400, gin.H{"error": "command is required"})
		return
	}
	if !isLikelyCron(p.Schedule) {
		c.JSON(400, gin.H{"error": "invalid cron schedule — must be exactly 5 space-separated fields"})
		return
	}
	if p.TimeoutSeconds <= 0 {
		p.TimeoutSeconds = 300
	}
	workingDir := strings.TrimSpace(p.WorkingDir)
	if workingDir != "" {
		if !filepath.IsAbs(workingDir) {
			c.JSON(400, gin.H{"error": "working_directory must be an absolute path"})
			return
		}
		info, err := os.Stat(workingDir)
		if err != nil || !info.IsDir() {
			c.JSON(400, gin.H{"error": "working_directory does not exist or is not a directory"})
			return
		}
	}
	_, err := a.db.Exec(c,
		"insert into cron_jobs(id,name,schedule,working_dir,command,comment,logging_enabled,timeout_seconds) values($1,$2,$3,$4,$5,$6,$7,$8)",
		uuid.New(), p.Name, p.Schedule, workingDir, p.Command, p.Comment, p.LoggingEnabled, p.TimeoutSeconds,
	)
	if err != nil {
		slog.Error("createJob db insert", "err", err)
		c.JSON(500, gin.H{"error": "failed to create job"})
		return
	}
	c.JSON(201, gin.H{"ok": true})
}

func (a *app) deleteJob(c *gin.Context) {
	id := c.Param("id")
	if _, err := uuid.Parse(id); err != nil {
		c.JSON(400, gin.H{"error": "invalid job ID format"})
		return
	}
	tag, err := a.db.Exec(c, "delete from cron_jobs where id=$1", id)
	if err != nil {
		slog.Error("deleteJob db", "id", id, "err", err)
		c.JSON(500, gin.H{"error": "failed to delete job"})
		return
	}
	if tag.RowsAffected() == 0 {
		c.JSON(404, gin.H{"error": "job not found"})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

func (a *app) runJobManual(c *gin.Context) {
	id := c.Param("id")
	if _, err := uuid.Parse(id); err != nil {
		c.JSON(400, gin.H{"error": "invalid job ID format"})
		return
	}
	var jobID uuid.UUID
	var name, command, workingDir string
	var loggingEnabled bool
	var timeout int
	err := a.db.QueryRow(c,
		"select id,name,working_dir,command,logging_enabled,timeout_seconds from cron_jobs where id=$1", id,
	).Scan(&jobID, &name, &workingDir, &command, &loggingEnabled, &timeout)
	if err != nil {
		c.JSON(404, gin.H{"error": "job not found"})
		return
	}
	if loggingEnabled {
		go func() {
			if _, err := a.executeJob(context.Background(), jobID, name, workingDir, command, timeout); err != nil {
				slog.Error("background job execution failed", "job", name, "err", err)
			}
		}()
		c.JSON(202, gin.H{"status": "started_in_background"})
		return
	}
	runID, err := a.executeJob(c, jobID, name, workingDir, command, timeout)
	if err != nil {
		slog.Error("manual job execution failed", "job", name, "err", err)
		c.JSON(500, gin.H{"error": "job execution failed: " + err.Error()})
		return
	}
	c.JSON(200, gin.H{"run_id": runID})
}

func (a *app) executeJob(ctx context.Context, jobID uuid.UUID, name, workingDir, command string, timeoutSeconds int) (uuid.UUID, error) {
	runID := uuid.New()
	started := time.Now()
	if _, err := a.db.Exec(ctx,
		"insert into job_runs(id,job_id,job_name,command,status,started_at) values($1,$2,$3,$4,'running',$5)",
		runID, jobID, name, command, started,
	); err != nil {
		return uuid.Nil, fmt.Errorf("insert run record: %w", err)
	}
	a.publish(runID.String(), `{"status":"running"}`)

	execCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutSeconds)*time.Second)
	defer cancel()

	cmd := exec.CommandContext(execCtx, "bash", "-lc", command)
	if strings.TrimSpace(workingDir) != "" {
		cmd.Dir = filepath.Clean(workingDir)
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	stdoutPipe, pipeErr := cmd.StdoutPipe()
	if pipeErr != nil {
		a.markRunFailed(runID, "pipe error", "internal error creating stdout pipe")
		return uuid.Nil, fmt.Errorf("stdout pipe: %w", pipeErr)
	}
	stderrPipe, pipeErr := cmd.StderrPipe()
	if pipeErr != nil {
		a.markRunFailed(runID, "pipe error", "internal error creating stderr pipe")
		return uuid.Nil, fmt.Errorf("stderr pipe: %w", pipeErr)
	}

	if err := cmd.Start(); err != nil {
		a.markRunFailed(runID, "start error", err.Error())
		return uuid.Nil, fmt.Errorf("start command: %w", err)
	}

	var outBuf strings.Builder
	var errBuf strings.Builder
	var wg sync.WaitGroup

	streamPipe := func(prefix string, r io.Reader, buf *strings.Builder) {
		defer wg.Done()
		sc := bufio.NewScanner(r)
		for sc.Scan() {
			line := sc.Text()
			buf.WriteString(line + "\n")
			msg, _ := json.Marshal(gin.H{"status": "running", "stream": prefix, "line": line})
			a.publish(runID.String(), string(msg))
		}
	}
	wg.Add(2)
	go streamPipe("stdout", stdoutPipe, &outBuf)
	go streamPipe("stderr", stderrPipe, &errBuf)

	waitErr := cmd.Wait()
	wg.Wait()

	stdout := outBuf.String()
	stderr := errBuf.String()
	exitCode := 0
	status := "success"
	failureReason := ""
	failureFix := ""
	if waitErr != nil {
		status = "failure"
		exitCode = 1
		if exitErr, ok := waitErr.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		}
		failureReason, failureFix = diagnoseError(execCtx.Err(), stderr)
	}

	if _, dbErr := a.db.Exec(context.Background(),
		`update job_runs set status=$2, exit_code=$3, stdout=$4, stderr=$5, ended_at=$6, failure_reason=$7, failure_fix=$8 where id=$1`,
		runID, status, exitCode, stdout, stderr, time.Now(), failureReason, failureFix,
	); dbErr != nil {
		slog.Error("executeJob update run", "run_id", runID, "err", dbErr)
		return uuid.Nil, fmt.Errorf("update run record: %w", dbErr)
	}

	event, _ := json.Marshal(gin.H{"status": status, "stdout": stdout, "stderr": stderr, "exit_code": exitCode})
	a.publish(runID.String(), string(event))
	return runID, nil
}

// markRunFailed updates a run row to failure status when execution cannot start.
func (a *app) markRunFailed(runID uuid.UUID, reason, fix string) {
	_, err := a.db.Exec(context.Background(),
		`update job_runs set status='failure', ended_at=$2, failure_reason=$3, failure_fix=$4 where id=$1`,
		runID, time.Now(), reason, fix,
	)
	if err != nil {
		slog.Error("markRunFailed", "run_id", runID, "err", err)
	}
	event, _ := json.Marshal(gin.H{"status": "failure", "failure_reason": reason})
	a.publish(runID.String(), string(event))
}

func (a *app) listRuns(c *gin.Context) {
	rows, err := a.db.Query(c,
		"select id,job_id,job_name,status,exit_code,started_at,ended_at,failure_reason,failure_fix from job_runs order by started_at desc limit 100")
	if err != nil {
		slog.Error("listRuns query", "err", err)
		c.JSON(500, gin.H{"error": "failed to query runs"})
		return
	}
	defer rows.Close()

	out := make([]gin.H, 0)
	for rows.Next() {
		var id uuid.UUID
		var jobID *uuid.UUID
		var name, status, reason, fix string
		var exitCode *int
		var started time.Time
		var ended *time.Time
		if err := rows.Scan(&id, &jobID, &name, &status, &exitCode, &started, &ended, &reason, &fix); err != nil {
			slog.Error("listRuns scan", "err", err)
			c.JSON(500, gin.H{"error": "failed to read run row"})
			return
		}
		out = append(out, gin.H{
			"id": id, "job_id": jobID, "job_name": name, "status": status,
			"exit_code": exitCode, "started_at": started, "ended_at": ended,
			"failure_reason": reason, "failure_fix": fix,
		})
	}
	if err := rows.Err(); err != nil {
		slog.Error("listRuns rows", "err", err)
		c.JSON(500, gin.H{"error": "error iterating runs"})
		return
	}
	c.JSON(200, out)
}

func (a *app) getRunLogs(c *gin.Context) {
	id := c.Param("id")
	if _, err := uuid.Parse(id); err != nil {
		c.JSON(400, gin.H{"error": "invalid run ID format"})
		return
	}
	var stdout, stderr string
	if err := a.db.QueryRow(c, "select stdout,stderr from job_runs where id=$1", id).Scan(&stdout, &stderr); err != nil {
		c.JSON(404, gin.H{"error": "run not found"})
		return
	}
	c.JSON(200, gin.H{"stdout": stdout, "stderr": stderr})
}

func (a *app) streamRun(c *gin.Context) {
	id := c.Param("id")
	ch := make(chan string, 16)
	a.mu.Lock()
	a.subscribers[id] = append(a.subscribers[id], ch)
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		subs := a.subscribers[id]
		filtered := make([]chan string, 0, len(subs))
		for _, s := range subs {
			if s != ch {
				filtered = append(filtered, s)
			}
		}
		a.subscribers[id] = filtered
		a.mu.Unlock()
		close(ch)
	}()

	c.Writer.Header().Set("Content-Type", "text/event-stream")
	c.Writer.Header().Set("Cache-Control", "no-cache")
	c.Writer.Header().Set("Connection", "keep-alive")
	c.Stream(func(w io.Writer) bool {
		select {
		case msg := <-ch:
			c.SSEvent("message", msg)
			return true
		case <-c.Request.Context().Done():
			return false
		}
	})
}

func (a *app) publish(runID, message string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, ch := range a.subscribers[runID] {
		select {
		case ch <- message:
		default:
		}
	}
}

func (a *app) systemInfo(c *gin.Context) {
	up, _ := host.Uptime()
	vm, _ := mem.VirtualMemory()
	ld, _ := load.Avg()
	cpus, _ := cpu.Info()
	parts, _ := disk.Partitions(false)
	diskStats := make([]gin.H, 0)
	for _, p := range parts {
		if usage, err := disk.Usage(p.Mountpoint); err == nil {
			diskStats = append(diskStats, gin.H{"path": p.Mountpoint, "used_percent": usage.UsedPercent})
		}
	}
	netIO, _ := net.IOCounters(false)
	c.JSON(200, gin.H{
		"uptime_seconds": up,
		"memory":         vm,
		"load":           ld,
		"cpu_count":      len(cpus),
		"disks":          diskStats,
		"network":        netIO,
		"gpu":            "unavailable in generic container context",
	})
}

func (a *app) schedulerLoop(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := a.runDueJobs(context.Background()); err != nil {
				slog.Error("scheduler tick failed", "err", err)
			}
		}
	}
}

func (a *app) cleanupLoop(ctx context.Context, retention time.Duration) {
	ticker := time.NewTicker(1 * time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			_, err := a.db.Exec(context.Background(),
				"delete from job_runs where started_at < now() - $1::interval",
				fmt.Sprintf("%.0f seconds", retention.Seconds()),
			)
			if err != nil {
				slog.Error("cleanup loop failed", "err", err)
			}
		}
	}
}

func (a *app) runDueJobs(ctx context.Context) error {
	rows, err := a.db.Query(ctx,
		"select id,name,schedule,working_dir,command,logging_enabled,timeout_seconds from cron_jobs")
	if err != nil {
		return fmt.Errorf("query due jobs: %w", err)
	}
	defer rows.Close()

	now := time.Now()
	for rows.Next() {
		var id uuid.UUID
		var name, schedule, workingDir, command string
		var loggingEnabled bool
		var timeout int
		if err := rows.Scan(&id, &name, &schedule, &workingDir, &command, &loggingEnabled, &timeout); err != nil {
			slog.Error("runDueJobs scan", "err", err)
			continue
		}
		if !matchesCron(schedule, now) {
			continue
		}
		a.mu.Lock()
		last, ok := a.lastTickRun[id.String()]
		if ok && now.Sub(last) < time.Minute {
			a.mu.Unlock()
			continue
		}
		a.lastTickRun[id.String()] = now
		a.mu.Unlock()

		if loggingEnabled {
			go func(id uuid.UUID, name, workingDir, command string, timeout int) {
				if _, err := a.executeJob(context.Background(), id, name, workingDir, command, timeout); err != nil {
					slog.Error("scheduled job failed", "job", name, "err", err)
				}
			}(id, name, workingDir, command, timeout)
		} else {
			if _, err := a.executeJob(context.Background(), id, name, workingDir, command, timeout); err != nil {
				slog.Error("scheduled job failed", "job", name, "err", err)
			}
		}
	}
	return rows.Err()
}

func envOr(k, fallback string) string {
	v := strings.TrimSpace(os.Getenv(k))
	if v == "" {
		return fallback
	}
	return v
}

func isLikelyCron(s string) bool {
	return len(strings.Fields(s)) == 5
}

func matchesCron(spec string, now time.Time) bool {
	fields := strings.Fields(spec)
	if len(fields) != 5 {
		return false
	}
	min, hr, day, mon, dow := fields[0], fields[1], fields[2], fields[3], fields[4]
	return cronMatch(min, now.Minute()) &&
		cronMatch(hr, now.Hour()) &&
		cronMatch(day, now.Day()) &&
		cronMatch(mon, int(now.Month())) &&
		cronMatch(dow, int(now.Weekday()))
}

func cronMatch(field string, val int) bool {
	if field == "*" {
		return true
	}
	if strings.HasPrefix(field, "*/") {
		n, err := strconv.Atoi(strings.TrimPrefix(field, "*/"))
		return err == nil && n > 0 && val%n == 0
	}
	for _, p := range strings.Split(field, ",") {
		x, err := strconv.Atoi(strings.TrimSpace(p))
		if err == nil && x == val {
			return true
		}
	}
	return false
}

func diagnoseError(timeoutErr error, stderr string) (string, string) {
	if errors.Is(timeoutErr, context.DeadlineExceeded) {
		return "Execution timed out", "Increase timeout_seconds or optimize the script runtime"
	}
	lower := strings.ToLower(stderr)
	switch {
	case strings.Contains(lower, "permission denied"):
		return "Permission denied", "Ensure the script/executable has correct permissions and the user has access"
	case strings.Contains(lower, "command not found"):
		return "Command not found", "Install the missing command or add it to PATH in the script"
	case strings.Contains(lower, "no such file"):
		return "File not found", "Check script paths and working directory settings"
	default:
		return "Non-zero exit code", "Inspect stderr logs and add validation or guard clauses in the script"
	}
}
