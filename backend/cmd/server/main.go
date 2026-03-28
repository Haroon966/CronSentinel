package main

import (
	"bufio"
	"context"
	"database/sql"
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
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/load"
	"github.com/shirou/gopsutil/v4/mem"
	"github.com/shirou/gopsutil/v4/net"

	"cronsentinel/internal/heartbeat"
	"cronsentinel/internal/notify"
)

type app struct {
	db          *pgxpool.Pool
	scriptDir   string
	subscribers map[string][]chan string
	lastTickRun map[string]time.Time
	hbLimiter   *heartbeat.TokenRateLimiter
	mu          sync.Mutex
}

type scriptPayload struct {
	Name    string `json:"name"`
	Content string `json:"content"`
}

type jobPayload struct {
	Name           string `json:"name"`
	Schedule       string `json:"schedule"`
	Timezone       string `json:"timezone"`
	WorkingDir     string `json:"working_directory"`
	Command        string `json:"command"`
	Comment        string `json:"comment"`
	LoggingEnabled        bool `json:"logging_enabled"`
	TimeoutSeconds        int  `json:"timeout_seconds"`
	HeartbeatGraceSeconds int  `json:"heartbeat_grace_seconds"`
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
		hbLimiter:   heartbeat.NewTokenRateLimiter(10 * time.Second),
	}
	if err := a.ensureSchema(ctx); err != nil {
		slog.Error("failed to apply schema", "err", err)
		os.Exit(1)
	}

	go a.schedulerLoop(context.Background())
	go a.cleanupLoop(context.Background(), 7*24*time.Hour)
	go a.heartbeatWatchLoop(context.Background())

	r := gin.Default()
	r.Use(cors.Default())

	r.GET("/healthz", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) })
	r.GET("/api/system", a.systemInfo)
	r.GET("/api/scripts", a.listScripts)
	r.POST("/api/scripts", a.createScript)
	r.DELETE("/api/scripts/:name", a.deleteScript)

	r.POST("/api/heartbeat/:token", a.postHeartbeat)

	r.GET("/api/jobs", a.listJobs)
	r.GET("/api/jobs/presets", a.jobPresets)
	r.POST("/api/jobs", a.createJob)
	r.PUT("/api/jobs/:id", a.updateJob)
	r.DELETE("/api/jobs/:id", a.deleteJob)
	r.POST("/api/jobs/:id/run", a.runJobManual)
	r.GET("/api/runs", a.listRuns)
	r.POST("/api/runs/email", a.emailRunsReport)
	r.GET("/api/runs/:id/logs", a.getRunLogs)
	r.GET("/api/runs/:id/stream", a.streamRun)

	r.GET("/api/settings/notifications", a.getNotificationSettings)
	r.PUT("/api/settings/notifications", a.putNotificationSettings)
	r.POST("/api/settings/notifications/test", a.postNotificationTest)

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
  timezone text not null default 'Local',
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
	if _, err := a.db.Exec(ctx, "alter table cron_jobs add column if not exists timezone text not null default 'Local'"); err != nil {
		return fmt.Errorf("migrate timezone: %w", err)
	}
	notifCreate := `
create table if not exists notification_settings (
  id int primary key check (id = 1),
  enabled boolean not null default false,
  smtp_host text not null default '',
  smtp_port int not null default 587,
  smtp_username text not null default '',
  smtp_password text not null default '',
  smtp_tls boolean not null default true,
  from_address text not null default '',
  to_addresses text not null default '',
  notify_scheduled_success boolean not null default false,
  notify_scheduled_failure boolean not null default false,
  notify_manual_success boolean not null default false,
  notify_manual_failure boolean not null default false
)`
	if _, err := a.db.Exec(ctx, notifCreate); err != nil {
		return fmt.Errorf("notification_settings create: %w", err)
	}
	if _, err := a.db.Exec(ctx, "insert into notification_settings (id) values (1) on conflict (id) do nothing"); err != nil {
		return fmt.Errorf("notification_settings seed: %w", err)
	}
	if _, err := a.db.Exec(ctx, "alter table notification_settings add column if not exists notify_heartbeat_missed boolean not null default false"); err != nil {
		return fmt.Errorf("migrate notify_heartbeat_missed: %w", err)
	}
	hbPings := `
create table if not exists heartbeat_pings (
  id uuid primary key,
  job_id uuid not null references cron_jobs(id) on delete cascade,
  received_at timestamptz not null default now(),
  client_ip text not null default '',
  payload text not null default ''
);
create index if not exists heartbeat_pings_job_received_idx on heartbeat_pings (job_id, received_at desc);
`
	if _, err := a.db.Exec(ctx, hbPings); err != nil {
		return fmt.Errorf("heartbeat_pings: %w", err)
	}
	for _, q := range []string{
		"alter table cron_jobs add column if not exists heartbeat_token text",
		"alter table cron_jobs add column if not exists heartbeat_grace_seconds int not null default 300",
		"alter table cron_jobs add column if not exists last_heartbeat_at timestamptz",
		"alter table cron_jobs add column if not exists last_heartbeat_alert_at timestamptz",
	} {
		if _, err := a.db.Exec(ctx, q); err != nil {
			return fmt.Errorf("migrate cron_jobs heartbeat: %w", err)
		}
	}
	if _, err := a.db.Exec(ctx, `update cron_jobs set heartbeat_token = md5(random()::text || id::text || clock_timestamp()::text) || md5(random()::text || id::text || random()::text) where heartbeat_token is null or heartbeat_token = ''`); err != nil {
		return fmt.Errorf("backfill heartbeat_token: %w", err)
	}
	if _, err := a.db.Exec(ctx, "alter table cron_jobs alter column heartbeat_token set not null"); err != nil {
		return fmt.Errorf("heartbeat_token not null: %w", err)
	}
	if _, err := a.db.Exec(ctx, "create unique index if not exists cron_jobs_heartbeat_token_key on cron_jobs (heartbeat_token)"); err != nil {
		return fmt.Errorf("heartbeat_token unique: %w", err)
	}
	absenceAlerts := `
create table if not exists absence_alerts (
  id uuid primary key,
  job_id uuid not null references cron_jobs(id) on delete cascade,
  created_at timestamptz not null default now(),
  scheduled_fire_at timestamptz not null,
  minutes_late int not null,
  job_name_snapshot text not null default '',
  notification_sent boolean not null default false
);
create index if not exists absence_alerts_job_created_idx on absence_alerts (job_id, created_at desc);
`
	if _, err := a.db.Exec(ctx, absenceAlerts); err != nil {
		return fmt.Errorf("absence_alerts: %w", err)
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
		`select id,name,schedule,timezone,working_dir,command,comment,logging_enabled,timeout_seconds,created_at,
			heartbeat_token, heartbeat_grace_seconds, last_heartbeat_at
		 from cron_jobs order by created_at desc`)
	if err != nil {
		slog.Error("listJobs query", "err", err)
		c.JSON(500, gin.H{"error": "failed to query jobs"})
		return
	}
	defer rows.Close()

	now := time.Now()
	out := make([]gin.H, 0)
	for rows.Next() {
		var id uuid.UUID
		var name, schedule, timezone, workingDir, cmd, comment string
		var logEnabled bool
		var timeout int
		var created time.Time
		var hbToken string
		var grace int
		var lastHB *time.Time
		var lastN sql.NullTime
		if err := rows.Scan(&id, &name, &schedule, &timezone, &workingDir, &cmd, &comment, &logEnabled, &timeout, &created,
			&hbToken, &grace, &lastN); err != nil {
			slog.Error("listJobs scan", "err", err)
			c.JSON(500, gin.H{"error": "failed to read job row"})
			return
		}
		if lastN.Valid {
			t := lastN.Time
			lastHB = &t
		}
		st := heartbeat.Classify(schedule, timezone, grace, created, lastHB, now)
		var lastAt any
		if lastHB != nil {
			lastAt = lastHB.UTC().Format(time.RFC3339Nano)
		} else {
			lastAt = nil
		}
		out = append(out, gin.H{
			"id": id, "name": name, "schedule": schedule, "timezone": timezone, "working_directory": workingDir,
			"command": cmd, "comment": comment, "logging_enabled": logEnabled,
			"timeout_seconds": timeout, "created_at": created,
			"heartbeat_token":              hbToken,
			"heartbeat_grace_seconds":      grace,
			"last_heartbeat_at":            lastAt,
			"heartbeat_status":             st.Status,
			"heartbeat_deadline_at":        st.Deadline.UTC().Format(time.RFC3339Nano),
			"heartbeat_prev_fire_at":       st.PrevFire.UTC().Format(time.RFC3339Nano),
			"heartbeat_interval_seconds":   st.IntervalSeconds,
			"heartbeat_first_ping_due_by":  st.FirstPingDueBy.UTC().Format(time.RFC3339Nano),
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
	grace := p.HeartbeatGraceSeconds
	if grace <= 0 {
		grace = 300
	}
	if grace > 604800 {
		grace = 604800
	}
	timezone := strings.TrimSpace(p.Timezone)
	if timezone == "" {
		timezone = "Local"
	}
	if timezone != "Local" {
		if _, err := time.LoadLocation(timezone); err != nil {
			c.JSON(400, gin.H{"error": "invalid timezone"})
			return
		}
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
	hbTok, err := heartbeat.GenerateToken()
	if err != nil {
		slog.Error("createJob heartbeat token", "err", err)
		c.JSON(500, gin.H{"error": "failed to create job"})
		return
	}
	_, err = a.db.Exec(c,
		`insert into cron_jobs(id,name,schedule,timezone,working_dir,command,comment,logging_enabled,timeout_seconds,heartbeat_token,heartbeat_grace_seconds)
		 values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
		uuid.New(), p.Name, p.Schedule, timezone, workingDir, p.Command, p.Comment, p.LoggingEnabled, p.TimeoutSeconds, hbTok, grace,
	)
	if err != nil {
		slog.Error("createJob db insert", "err", err)
		c.JSON(500, gin.H{"error": "failed to create job"})
		return
	}
	c.JSON(201, gin.H{"ok": true})
}

func (a *app) updateJob(c *gin.Context) {
	id := c.Param("id")
	if _, err := uuid.Parse(id); err != nil {
		c.JSON(400, gin.H{"error": "invalid job ID format"})
		return
	}

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
	grace := p.HeartbeatGraceSeconds
	if grace <= 0 {
		grace = 300
	}
	if grace > 604800 {
		grace = 604800
	}
	timezone := strings.TrimSpace(p.Timezone)
	if timezone == "" {
		timezone = "Local"
	}
	if timezone != "Local" {
		if _, err := time.LoadLocation(timezone); err != nil {
			c.JSON(400, gin.H{"error": "invalid timezone"})
			return
		}
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
	tag, err := a.db.Exec(c,
		`update cron_jobs set name=$2,schedule=$3,timezone=$4,working_dir=$5,command=$6,comment=$7,logging_enabled=$8,timeout_seconds=$9,heartbeat_grace_seconds=$10 where id=$1`,
		id, p.Name, p.Schedule, timezone, workingDir, p.Command, p.Comment, p.LoggingEnabled, p.TimeoutSeconds, grace,
	)
	if err != nil {
		slog.Error("updateJob db update", "id", id, "err", err)
		c.JSON(500, gin.H{"error": "failed to update job"})
		return
	}
	if tag.RowsAffected() == 0 {
		c.JSON(404, gin.H{"error": "job not found"})
		return
	}
	c.JSON(200, gin.H{"ok": true})
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
		runID := uuid.New()
		if _, err := a.db.Exec(c,
			"insert into job_runs(id,job_id,job_name,command,status,started_at) values($1,$2,$3,$4,'running',$5)",
			runID, jobID, name, command, time.Now(),
		); err != nil {
			slog.Error("runJobManual insert run record", "job", name, "err", err)
			c.JSON(500, gin.H{"error": "failed to start job"})
			return
		}
		go func() {
			if _, err := a.executeJob(context.Background(), jobID, name, workingDir, command, timeout, &runID, "manual"); err != nil {
				slog.Error("background job execution failed", "job", name, "err", err)
			}
		}()
		c.JSON(202, gin.H{"status": "started_in_background", "run_id": runID})
		return
	}
	runID, err := a.executeJob(c, jobID, name, workingDir, command, timeout, nil, "manual")
	if err != nil {
		slog.Error("manual job execution failed", "job", name, "err", err)
		c.JSON(500, gin.H{"error": "job execution failed: " + err.Error()})
		return
	}
	c.JSON(200, gin.H{"run_id": runID})
}

func (a *app) executeJob(ctx context.Context, jobID uuid.UUID, name, workingDir, command string, timeoutSeconds int, existingRunID *uuid.UUID, trigger string) (uuid.UUID, error) {
	runID := uuid.New()
	if existingRunID != nil {
		runID = *existingRunID
	} else {
		started := time.Now()
		if _, err := a.db.Exec(ctx,
			"insert into job_runs(id,job_id,job_name,command,status,started_at) values($1,$2,$3,$4,'running',$5)",
			runID, jobID, name, command, started,
		); err != nil {
			return uuid.Nil, fmt.Errorf("insert run record: %w", err)
		}
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
		a.markRunFailed(runID, "pipe error", "internal error creating stdout pipe", trigger)
		return uuid.Nil, fmt.Errorf("stdout pipe: %w", pipeErr)
	}
	stderrPipe, pipeErr := cmd.StderrPipe()
	if pipeErr != nil {
		a.markRunFailed(runID, "pipe error", "internal error creating stderr pipe", trigger)
		return uuid.Nil, fmt.Errorf("stderr pipe: %w", pipeErr)
	}

	if err := cmd.Start(); err != nil {
		a.markRunFailed(runID, "start error", err.Error(), trigger)
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
	a.notifyRunCompletedBackground(runID, trigger)
	return runID, nil
}

// markRunFailed updates a run row to failure status when execution cannot start.
func (a *app) markRunFailed(runID uuid.UUID, reason, fix, trigger string) {
	_, err := a.db.Exec(context.Background(),
		`update job_runs set status='failure', ended_at=$2, failure_reason=$3, failure_fix=$4 where id=$1`,
		runID, time.Now(), reason, fix,
	)
	if err != nil {
		slog.Error("markRunFailed", "run_id", runID, "err", err)
	}
	event, _ := json.Marshal(gin.H{"status": "failure", "failure_reason": reason})
	a.publish(runID.String(), string(event))
	a.notifyRunCompletedBackground(runID, trigger)
}

func (a *app) notifyRunCompletedBackground(runID uuid.UUID, trigger string) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
		defer cancel()
		var jobName, command, status, failureReason, stdout, stderr string
		var exitCode *int
		err := a.db.QueryRow(ctx,
			`select job_name, command, status, exit_code, coalesce(failure_reason,''), coalesce(stdout,''), coalesce(stderr,'') from job_runs where id=$1`,
			runID,
		).Scan(&jobName, &command, &status, &exitCode, &failureReason, &stdout, &stderr)
		if err != nil {
			slog.Error("notify load run", "run_id", runID, "err", err)
			return
		}
		s, err := notify.Load(ctx, a.db)
		if err != nil || !notify.ShouldNotifyRun(s, trigger, status) || !notify.CanSend(s) {
			return
		}
		subj, body := notify.FormatRunCompleted(jobName, command, status, runID.String(), exitCode, failureReason, stdout, stderr)
		if err := notify.SendPlain(s, subj, body); err != nil {
			slog.Error("notify send", "run_id", runID, "err", err)
		}
	}()
}

// buildRunsWhere returns SQL fragments for filtering job_runs. Maps UI status "failed" to DB "failure".
func buildRunsWhere(status, search, jobID string) ([]string, []any, int, error) {
	where := make([]string, 0, 3)
	args := make([]any, 0, 6)
	argN := 1
	status = strings.TrimSpace(strings.ToLower(status))
	if status == "failed" {
		status = "failure"
	}
	if status != "" && status != "all" {
		where = append(where, fmt.Sprintf("lower(status) = $%d", argN))
		args = append(args, status)
		argN++
	}
	if s := strings.TrimSpace(search); s != "" {
		where = append(where, fmt.Sprintf("(job_name ilike $%d or command ilike $%d)", argN, argN))
		args = append(args, "%"+s+"%")
		argN++
	}
	if jid := strings.TrimSpace(jobID); jid != "" {
		if _, err := uuid.Parse(jid); err != nil {
			return nil, nil, 0, err
		}
		where = append(where, fmt.Sprintf("job_id = $%d", argN))
		args = append(args, jid)
		argN++
	}
	return where, args, argN, nil
}

func (a *app) listRuns(c *gin.Context) {
	limit := parseIntParam(c.Query("limit"), 50, 1, 500)
	offset := parseIntParam(c.Query("offset"), 0, 0, 1_000_000)
	status := strings.TrimSpace(strings.ToLower(c.Query("status")))
	search := strings.TrimSpace(c.Query("search"))
	jobID := strings.TrimSpace(c.Query("job_id"))

	where, args, argN, werr := buildRunsWhere(status, search, jobID)
	if werr != nil {
		c.JSON(400, gin.H{"error": "invalid job ID format"})
		return
	}

	whereSQL := ""
	if len(where) > 0 {
		whereSQL = " where " + strings.Join(where, " and ")
	}

	countSQL := "select count(*) from job_runs" + whereSQL
	var total int
	if err := a.db.QueryRow(c, countSQL, args...).Scan(&total); err != nil {
		slog.Error("listRuns count query", "err", err)
		c.JSON(500, gin.H{"error": "failed to count runs"})
		return
	}

	args = append(args, limit, offset)
	rows, err := a.db.Query(c,
		"select id,job_id,job_name,command,status,exit_code,started_at,ended_at,failure_reason,failure_fix from job_runs"+whereSQL+" order by started_at desc limit $"+strconv.Itoa(argN)+" offset $"+strconv.Itoa(argN+1),
		args...,
	)
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
		var name, command, status, reason, fix string
		var exitCode *int
		var started time.Time
		var ended *time.Time
		if err := rows.Scan(&id, &jobID, &name, &command, &status, &exitCode, &started, &ended, &reason, &fix); err != nil {
			slog.Error("listRuns scan", "err", err)
			c.JSON(500, gin.H{"error": "failed to read run row"})
			return
		}
		out = append(out, gin.H{
			"id": id, "job_id": jobID, "job_name": name, "command": command, "status": status,
			"exit_code": exitCode, "started_at": started, "ended_at": ended,
			"failure_reason": reason, "failure_fix": fix,
		})
	}
	if err := rows.Err(); err != nil {
		slog.Error("listRuns rows", "err", err)
		c.JSON(500, gin.H{"error": "error iterating runs"})
		return
	}
	hasMore := offset+len(out) < total
	c.JSON(200, gin.H{
		"items":    out,
		"total":    total,
		"limit":    limit,
		"offset":   offset,
		"has_more": hasMore,
	})
}

func (a *app) getNotificationSettings(c *gin.Context) {
	s, err := notify.Load(c.Request.Context(), a.db)
	if err != nil {
		slog.Error("getNotificationSettings", "err", err)
		c.JSON(500, gin.H{"error": "failed to load settings"})
		return
	}
	pwFromEnv := strings.TrimSpace(os.Getenv("NOTIFICATION_SMTP_PASSWORD")) != ""
	pwSet := pwFromEnv || strings.TrimSpace(s.SMTPPassword) != ""
	c.JSON(200, gin.H{
		"enabled":                   s.Enabled,
		"smtp_host":                 s.SMTPHost,
		"smtp_port":                 s.SMTPPort,
		"smtp_username":             s.SMTPUsername,
		"smtp_password_set":         pwSet,
		"smtp_password_from_env":    pwFromEnv,
		"smtp_tls":                  s.SMTPTLS,
		"from_address":              s.FromAddress,
		"to_addresses":              s.ToAddresses,
		"notify_scheduled_success":   s.NotifyScheduledSuccess,
		"notify_scheduled_failure":   s.NotifyScheduledFailure,
		"notify_manual_success":      s.NotifyManualSuccess,
		"notify_manual_failure":      s.NotifyManualFailure,
		"notify_heartbeat_missed":    s.NotifyHeartbeatMissed,
	})
}

func (a *app) putNotificationSettings(c *gin.Context) {
	var body struct {
		Enabled                 bool   `json:"enabled"`
		SMTPHost                string `json:"smtp_host"`
		SMTPPort                int    `json:"smtp_port"`
		SMTPUsername            string `json:"smtp_username"`
		SMTPPassword            string `json:"smtp_password"`
		SMTPTLS                 bool   `json:"smtp_tls"`
		FromAddress             string `json:"from_address"`
		ToAddresses             string `json:"to_addresses"`
		NotifyScheduledSuccess  bool   `json:"notify_scheduled_success"`
		NotifyScheduledFailure  bool   `json:"notify_scheduled_failure"`
		NotifyManualSuccess     bool   `json:"notify_manual_success"`
		NotifyManualFailure     bool   `json:"notify_manual_failure"`
		NotifyHeartbeatMissed   bool   `json:"notify_heartbeat_missed"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(400, gin.H{"error": "invalid JSON body"})
		return
	}
	if body.SMTPPort <= 0 || body.SMTPPort > 65535 {
		body.SMTPPort = 587
	}
	cur, err := notify.Load(c.Request.Context(), a.db)
	if err != nil {
		slog.Error("putNotificationSettings load", "err", err)
		c.JSON(500, gin.H{"error": "failed to load current settings"})
		return
	}
	pass := cur.SMTPPassword
	if strings.TrimSpace(body.SMTPPassword) != "" {
		pass = strings.TrimSpace(body.SMTPPassword)
	}
	_, err = a.db.Exec(c.Request.Context(), `
update notification_settings set
  enabled=$1, smtp_host=$2, smtp_port=$3, smtp_username=$4, smtp_password=$5, smtp_tls=$6,
  from_address=$7, to_addresses=$8,
  notify_scheduled_success=$9, notify_scheduled_failure=$10, notify_manual_success=$11, notify_manual_failure=$12,
  notify_heartbeat_missed=$13
where id=1`,
		body.Enabled, strings.TrimSpace(body.SMTPHost), body.SMTPPort, strings.TrimSpace(body.SMTPUsername), pass, body.SMTPTLS,
		strings.TrimSpace(body.FromAddress), strings.TrimSpace(body.ToAddresses),
		body.NotifyScheduledSuccess, body.NotifyScheduledFailure, body.NotifyManualSuccess, body.NotifyManualFailure,
		body.NotifyHeartbeatMissed,
	)
	if err != nil {
		slog.Error("putNotificationSettings exec", "err", err)
		c.JSON(500, gin.H{"error": "failed to save settings"})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

func (a *app) postNotificationTest(c *gin.Context) {
	s, err := notify.Load(c.Request.Context(), a.db)
	if err != nil {
		c.JSON(500, gin.H{"error": "failed to load settings"})
		return
	}
	if !notify.CanSend(s) {
		c.JSON(400, gin.H{"error": "notifications disabled or SMTP/recipients incomplete"})
		return
	}
	if !notify.HasCredentials(s) {
		c.JSON(400, gin.H{"error": "SMTP username and password are required for this server. Save a password or set NOTIFICATION_SMTP_PASSWORD."})
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 45*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- notify.SendPlain(s, "CronSentinel test email", "This is a test message from CronSentinel. If you received it, SMTP settings are working.")
	}()
	select {
	case <-ctx.Done():
		c.JSON(504, gin.H{"error": "sending the test email timed out; check host, port, and firewall"})
		return
	case err := <-done:
		if err != nil {
			slog.Error("notification test send failed", "err", err)
			c.JSON(502, gin.H{"error": err.Error()})
			return
		}
	}
	c.JSON(200, gin.H{"ok": true, "status": "sent"})
}

func (a *app) emailRunsReport(c *gin.Context) {
	var body struct {
		Status string `json:"status"`
		Search string `json:"search"`
		JobID  string `json:"job_id"`
		Limit  int    `json:"limit"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(400, gin.H{"error": "invalid JSON body"})
		return
	}
	limit := body.Limit
	if limit <= 0 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}
	s, err := notify.Load(c.Request.Context(), a.db)
	if err != nil {
		c.JSON(500, gin.H{"error": "failed to load settings"})
		return
	}
	if !notify.CanSend(s) {
		c.JSON(400, gin.H{"error": "notifications disabled or SMTP/recipients incomplete"})
		return
	}
	where, args, argN, werr := buildRunsWhere(body.Status, body.Search, body.JobID)
	if werr != nil {
		c.JSON(400, gin.H{"error": "invalid job_id"})
		return
	}
	whereSQL := ""
	if len(where) > 0 {
		whereSQL = " where " + strings.Join(where, " and ")
	}
	args = append(args, limit)
	q := "select id, job_name, command, status, exit_code, started_at, ended_at, coalesce(failure_reason,'') from job_runs" +
		whereSQL + " order by started_at desc limit $" + strconv.Itoa(argN)
	rows, err := a.db.Query(c.Request.Context(), q, args...)
	if err != nil {
		slog.Error("emailRunsReport query", "err", err)
		c.JSON(500, gin.H{"error": "failed to query runs"})
		return
	}
	defer rows.Close()
	var hist []notify.HistoryRun
	for rows.Next() {
		var id uuid.UUID
		var jobName, command, status, reason string
		var exitCode *int
		var started time.Time
		var ended *time.Time
		if err := rows.Scan(&id, &jobName, &command, &status, &exitCode, &started, &ended, &reason); err != nil {
			slog.Error("emailRunsReport scan", "err", err)
			c.JSON(500, gin.H{"error": "failed to read runs"})
			return
		}
		h := notify.HistoryRun{
			ID: id.String(), JobName: jobName, Command: command, Status: status,
			ExitCode: exitCode, StartedAt: started.Format(time.RFC3339), FailureReason: reason,
		}
		if ended != nil {
			h.EndedAt = ended.Format(time.RFC3339)
		}
		hist = append(hist, h)
	}
	if err := rows.Err(); err != nil {
		c.JSON(500, gin.H{"error": "error reading runs"})
		return
	}
	go func() {
		_, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		subj, txt := notify.FormatRunHistoryEmail(hist)
		if err := notify.SendPlain(s, subj, txt); err != nil {
			slog.Error("emailRunsReport send", "err", err)
		}
	}()
	c.JSON(202, gin.H{"status": "queued", "run_count": len(hist)})
}

func parseIntParam(raw string, fallback, min, max int) int {
	if strings.TrimSpace(raw) == "" {
		return fallback
	}
	v, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	if v < min {
		return min
	}
	if v > max {
		return max
	}
	return v
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
	if _, err := uuid.Parse(id); err != nil {
		c.JSON(400, gin.H{"error": "invalid run ID format"})
		return
	}
	var status string
	var stdout, stderr string
	var exitCode *int
	var endedAt *time.Time
	if err := a.db.QueryRow(c, "select status,stdout,stderr,exit_code,ended_at from job_runs where id=$1", id).Scan(&status, &stdout, &stderr, &exitCode, &endedAt); err != nil {
		c.JSON(404, gin.H{"error": "run not found"})
		return
	}

	if endedAt != nil || !strings.EqualFold(status, "running") {
		c.Writer.Header().Set("Content-Type", "text/event-stream")
		c.Writer.Header().Set("Cache-Control", "no-cache")
		c.Writer.Header().Set("Connection", "keep-alive")
		c.SSEvent("message", gin.H{"status": status, "stdout": stdout, "stderr": stderr, "exit_code": exitCode})
		return
	}

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
	subs := append([]chan string(nil), a.subscribers[runID]...)
	a.mu.Unlock()
	for _, ch := range subs {
		select {
		case ch <- message:
		case <-time.After(120 * time.Millisecond):
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
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			now := time.Now()
			if now.Second() != 0 {
				continue
			}
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

const maxHeartbeatPayload = 64 * 1024

func (a *app) postHeartbeat(c *gin.Context) {
	rawTok := strings.TrimSpace(c.Param("token"))
	if rawTok == "" {
		c.JSON(404, gin.H{"error": "unknown heartbeat token"})
		return
	}
	body, err := io.ReadAll(io.LimitReader(c.Request.Body, maxHeartbeatPayload+1))
	if err != nil {
		c.JSON(400, gin.H{"error": "could not read request body"})
		return
	}
	if len(body) > maxHeartbeatPayload {
		c.JSON(413, gin.H{"error": "payload too large"})
		return
	}
	payload := strings.ToValidUTF8(string(body), "")
	var jobID uuid.UUID
	err = a.db.QueryRow(c.Request.Context(), `select id from cron_jobs where heartbeat_token=$1`, rawTok).Scan(&jobID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			c.JSON(404, gin.H{"error": "unknown heartbeat token"})
			return
		}
		slog.Error("postHeartbeat lookup", "err", err)
		c.JSON(500, gin.H{"error": "failed to record heartbeat"})
		return
	}
	if !a.hbLimiter.Allow(rawTok, time.Now()) {
		c.JSON(429, gin.H{"error": "rate limited; wait before sending another heartbeat"})
		return
	}
	_, err = a.db.Exec(c.Request.Context(),
		`insert into heartbeat_pings(id,job_id,client_ip,payload) values($1,$2,$3,$4)`,
		uuid.New(), jobID, c.ClientIP(), payload,
	)
	if err != nil {
		slog.Error("postHeartbeat insert ping", "err", err)
		c.JSON(500, gin.H{"error": "failed to record heartbeat"})
		return
	}
	_, err = a.db.Exec(c.Request.Context(),
		`update cron_jobs set last_heartbeat_at=now(), last_heartbeat_alert_at=null where id=$1`, jobID,
	)
	if err != nil {
		slog.Error("postHeartbeat update job", "err", err)
		c.JSON(500, gin.H{"error": "failed to record heartbeat"})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

func (a *app) heartbeatWatchLoop(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			a.evaluateHeartbeats(context.Background())
		}
	}
}

func (a *app) evaluateHeartbeats(ctx context.Context) {
	ns, err := notify.Load(ctx, a.db)
	if err != nil {
		slog.Error("evaluateHeartbeats load notify", "err", err)
		return
	}
	notifyMiss := notify.ShouldNotifyHeartbeatMissed(ns)

	rows, err := a.db.Query(ctx,
		`select id, name, schedule, timezone, heartbeat_grace_seconds, created_at, last_heartbeat_at, last_heartbeat_alert_at from cron_jobs`,
	)
	if err != nil {
		slog.Error("evaluateHeartbeats query", "err", err)
		return
	}
	defer rows.Close()

	now := time.Now()
	for rows.Next() {
		var id uuid.UUID
		var name, sched, tz string
		var grace int
		var created time.Time
		var lastN, alertN sql.NullTime
		if err := rows.Scan(&id, &name, &sched, &tz, &grace, &created, &lastN, &alertN); err != nil {
			slog.Error("evaluateHeartbeats scan", "err", err)
			return
		}
		var lastHB *time.Time
		if lastN.Valid {
			t := lastN.Time
			lastHB = &t
		}
		st := heartbeat.Classify(sched, tz, grace, created, lastHB, now)
		if st.Status != heartbeat.StatusDead {
			continue
		}
		if !notifyMiss {
			continue
		}
		var lastAlertPtr *time.Time
		if alertN.Valid {
			t := alertN.Time
			lastAlertPtr = &t
		}
		if heartbeat.AbsenceAlertAlreadySentForWindow(lastAlertPtr, st.PrevFire) {
			continue
		}
		lastPing := ""
		if lastHB != nil {
			lastPing = lastHB.UTC().Format(time.RFC3339Nano)
		}
		minutesLate := int(now.Sub(st.PrevFire) / time.Minute)
		if minutesLate < 0 {
			minutesLate = 0
		}
		subject, body := notify.FormatHeartbeatMissed(
			name,
			st.Status,
			st.PrevFire.UTC().Format(time.RFC3339Nano),
			st.Deadline.UTC().Format(time.RFC3339Nano),
			minutesLate,
			lastPing,
		)
		if err := notify.SendPlainWithRetry(ns, subject, body); err != nil {
			slog.Error("evaluateHeartbeats send", "job", name, "err", err)
			continue
		}
		_, insErr := a.db.Exec(ctx,
			`insert into absence_alerts(id, job_id, scheduled_fire_at, minutes_late, job_name_snapshot, notification_sent) values($1,$2,$3,$4,$5,true)`,
			uuid.New(), id, st.PrevFire, minutesLate, name,
		)
		if insErr != nil {
			slog.Error("evaluateHeartbeats absence_alerts insert", "job", name, "err", insErr)
		}
		if _, err := a.db.Exec(ctx, `update cron_jobs set last_heartbeat_alert_at=now() where id=$1`, id); err != nil {
			slog.Error("evaluateHeartbeats alert stamp", "err", err)
		}
	}
	if err := rows.Err(); err != nil {
		slog.Error("evaluateHeartbeats rows", "err", err)
	}
}

func (a *app) runDueJobs(ctx context.Context) error {
	rows, err := a.db.Query(ctx,
		"select id,name,schedule,timezone,working_dir,command,logging_enabled,timeout_seconds from cron_jobs")
	if err != nil {
		return fmt.Errorf("query due jobs: %w", err)
	}
	defer rows.Close()

	now := time.Now()
	for rows.Next() {
		var id uuid.UUID
		var name, schedule, timezone, workingDir, command string
		var loggingEnabled bool
		var timeout int
		if err := rows.Scan(&id, &name, &schedule, &timezone, &workingDir, &command, &loggingEnabled, &timeout); err != nil {
			slog.Error("runDueJobs scan", "err", err)
			continue
		}
		loc := time.Local
		if strings.TrimSpace(timezone) != "" && timezone != "Local" {
			if loaded, err := time.LoadLocation(timezone); err == nil {
				loc = loaded
			}
		}
		jobNow := now.In(loc)
		if !heartbeat.MatchesCron(schedule, jobNow) {
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
				if _, err := a.executeJob(context.Background(), id, name, workingDir, command, timeout, nil, "scheduled"); err != nil {
					slog.Error("scheduled job failed", "job", name, "err", err)
				}
			}(id, name, workingDir, command, timeout)
		} else {
			if _, err := a.executeJob(context.Background(), id, name, workingDir, command, timeout, nil, "scheduled"); err != nil {
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
