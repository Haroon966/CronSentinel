package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/csv"
	"encoding/hex"
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
	"unicode/utf8"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"cronsentinel/internal/apikey"
	"cronsentinel/internal/envcrypto"
	"cronsentinel/internal/heartbeat"
	"cronsentinel/internal/jobenv"
	"cronsentinel/internal/linediff"
	"cronsentinel/internal/notify"
	"cronsentinel/internal/pricing"
	"cronsentinel/internal/runsingest"
	"cronsentinel/internal/systemreport"
)

type app struct {
	db           *pgxpool.Pool
	scriptDir    string
	publicBaseURL string
	subscribers  map[string][]chan string
	lastTickRun  map[string]time.Time
	hbLimiter    *heartbeat.TokenRateLimiter
	srvHbLimiter     *heartbeat.TokenRateLimiter
	cronSnapLimiter   *heartbeat.TokenRateLimiter
	envFetchLimiter   *heartbeat.TokenRateLimiter
	mu                sync.Mutex
	envKey            [32]byte
	envKeyDevFallback bool
	apiKeyHourly      *apikey.HourlyLimiter
	pricing           *pricing.Service
}

type scriptPayload struct {
	Name    string `json:"name"`
	Content string `json:"content"`
}

type serverPayload struct {
	Name string `json:"name"`
}

type serverUpdatePayload struct {
	CrontabPollIntervalSeconds *int `json:"crontab_poll_interval_seconds"`
}

type crontabSnapshotPayload struct {
	Content       string `json:"content"`
	ContentHash   string `json:"content_hash"`
	UserContext   string `json:"user_context"`
	CaptureError  string `json:"capture_error"`
}

type alertRoutingPayload struct {
	UseDefault bool     `json:"use_default_channels"`
	ChannelIDs []string `json:"channel_ids"`
}

type jobPayload struct {
	Name           string `json:"name"`
	Schedule       string `json:"schedule"`
	Timezone       string `json:"timezone"`
	WorkingDir     string `json:"working_directory"`
	Command        string `json:"command"`
	Comment        string `json:"comment"`
	LoggingEnabled        bool `json:"logging_enabled"`
	TimeoutSeconds               int  `json:"timeout_seconds"`
	TimeoutRemoteKillEnabled     bool `json:"timeout_remote_kill_enabled"`
	HeartbeatGraceSeconds int  `json:"heartbeat_grace_seconds"`
	SuccessExitCode       int  `json:"success_exit_code"`
	Enabled               *bool `json:"enabled,omitempty"`
	AlertRouting          *alertRoutingPayload `json:"alert_routing,omitempty"`
}

type jobEnvPutPayload struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// jobPayloadEnabled defaults to true when JSON omits "enabled" (backward compatible).
func jobPayloadEnabled(p *jobPayload) bool {
	if p == nil || p.Enabled == nil {
		return true
	}
	return *p.Enabled
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

	pricingSvc, err := pricing.LoadConfigured()
	if err != nil {
		slog.Error("pricing config", "err", err)
		os.Exit(1)
	}
	pricingSvc.BindDB(db)

	envKey, envDevFallback, err := envcrypto.LoadKey()
	if err != nil {
		slog.Error("env encryption key", "err", err)
		os.Exit(1)
	}
	if envDevFallback {
		slog.Warn("using derived dev env encryption key; set CRONSENTINEL_ENV_ENCRYPTION_KEY to a random 32-byte value (hex or base64) in production")
	}

	a := &app{
		db:                db,
		scriptDir:         scriptDir,
		publicBaseURL:     envOr("CRONSENTINEL_PUBLIC_BASE_URL", ""),
		subscribers:       make(map[string][]chan string),
		lastTickRun:       make(map[string]time.Time),
		hbLimiter:         heartbeat.NewTokenRateLimiter(10 * time.Second),
		srvHbLimiter:      heartbeat.NewTokenRateLimiter(30 * time.Second),
		cronSnapLimiter:   heartbeat.NewTokenRateLimiter(60 * time.Second),
		envFetchLimiter:   heartbeat.NewTokenRateLimiter(2 * time.Second),
		envKey:            envKey,
		envKeyDevFallback: envDevFallback,
		apiKeyHourly:      apikey.NewHourlyLimiter(1000),
		pricing:           pricingSvc,
	}
	if err := a.ensureSchema(ctx); err != nil {
		slog.Error("failed to apply schema", "err", err)
		os.Exit(1)
	}

	go a.schedulerLoop(context.Background())
	go a.cleanupLoop(context.Background(), 7*24*time.Hour)
	go a.heartbeatWatchLoop(context.Background())
	go a.serverWatchLoop(context.Background())
	go a.runTimeoutWatchLoop(context.Background())

	r := gin.Default()
	r.Use(cors.Default())

	r.GET("/healthz", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) })
	r.GET("/api/system", a.systemInfo)
	r.GET("/api/scripts", a.listScripts)
	r.POST("/api/scripts", a.createScript)
	r.DELETE("/api/scripts/:name", a.deleteScript)

	r.POST("/api/heartbeat/:token", a.postHeartbeat)
	r.POST("/api/server-heartbeat/:token", a.postServerHeartbeat)
	r.POST("/api/crontab-snapshot/:token", a.postCrontabSnapshot)
	r.GET("/api/crontab-snapshots", a.listCrontabSnapshots)

	r.GET("/api/servers", a.listServers)
	r.POST("/api/servers", a.createServer)
	r.PUT("/api/servers/:id", a.updateServer)
	r.DELETE("/api/servers/:id", a.deleteServer)

	r.GET("/api/jobs", a.listJobs)
	r.GET("/api/jobs/presets", a.jobPresets)
	r.POST("/api/jobs", a.createJob)
	r.PUT("/api/jobs/:id", a.updateJob)
	r.DELETE("/api/jobs/:id", a.deleteJob)
	r.POST("/api/jobs/:id/run", a.runJobManual)
	r.POST("/api/jobs/:id/runs", a.postJobRunIngest)
	r.GET("/api/jobs/:id/runs/pending-kill", a.getPendingKill)
	r.POST("/api/jobs/:id/runs/:runId/kill-ack", a.postKillAck)
	r.GET("/api/jobs/:id/env/agent", a.getJobEnvForAgent)
	r.GET("/api/jobs/:id/env", a.listJobEnv)
	r.PUT("/api/jobs/:id/env", a.putJobEnv)
	r.DELETE("/api/jobs/:id/env", a.deleteJobEnv)
	r.GET("/api/runs", a.listRuns)
	r.GET("/api/runs/export.csv", a.exportRunsCSV)
	r.POST("/api/runs/email", a.emailRunsReport)
	r.GET("/api/runs/:id/logs", a.getRunLogs)
	r.GET("/api/runs/:id/stream", a.streamRun)

	r.GET("/api/settings/onboarding", a.getOnboardingSettings)
	r.PATCH("/api/settings/onboarding", a.patchOnboardingSettings)
	r.GET("/api/settings/notifications", a.getNotificationSettings)
	r.PUT("/api/settings/notifications", a.putNotificationSettings)
	r.POST("/api/settings/notifications/test", a.postNotificationTest)

	r.GET("/api/settings/alert-channels", a.listAlertChannels)
	r.POST("/api/settings/alert-channels", a.createAlertChannel)
	r.PATCH("/api/settings/alert-channels/:id", a.patchAlertChannel)
	r.DELETE("/api/settings/alert-channels/:id", a.deleteAlertChannel)
	r.POST("/api/settings/alert-channels/:id/test", a.postAlertChannelTest)
	r.GET("/api/settings/alert-delivery-log", a.getAlertDeliveryLog)

	r.GET("/api/settings/api-keys", a.listAPIKeysSettings)
	r.POST("/api/settings/api-keys", a.createAPIKeySettings)
	r.DELETE("/api/settings/api-keys/:id", a.revokeAPIKeySettings)

	r.GET("/api/settings/billing", a.getBillingSettings)
	r.PATCH("/api/settings/billing", a.patchBillingSettings)

	r.GET("/api/openapi.json", a.serveOpenAPIJSON)
	r.GET("/api/docs", a.serveAPIDocs)

	v1 := r.Group("/api/v1", a.middlewareV1APIKey(), a.middlewareV1APIKeyRateLimit())
	{
		v1.GET("/jobs", a.v1ListJobs)
		v1.POST("/jobs", a.v1CreateJob)
		v1.GET("/jobs/:id/heartbeat-token", a.v1GetHeartbeatToken)
		v1.GET("/jobs/:id", a.v1GetJob)
		v1.PUT("/jobs/:id", a.v1UpdateJob)
		v1.DELETE("/jobs/:id", a.v1DeleteJob)
		v1.GET("/runs", a.v1ListRuns)
		v1.GET("/runs/:id", a.v1GetRun)
		v1.POST("/jobs/:id/run", a.v1RunJobManual)
	}

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
	if _, err := a.db.Exec(ctx, "alter table notification_settings add column if not exists notify_heartbeat_missed boolean not null default true"); err != nil {
		return fmt.Errorf("migrate notify_heartbeat_missed: %w", err)
	}
	if _, err := a.db.Exec(ctx, "alter table notification_settings alter column notify_heartbeat_missed set default true"); err != nil {
		return fmt.Errorf("migrate notify_heartbeat_missed default: %w", err)
	}
	if _, err := a.db.Exec(ctx, "update notification_settings set notify_heartbeat_missed = true where id = 1"); err != nil {
		return fmt.Errorf("migrate notify_heartbeat_missed backfill: %w", err)
	}
	if _, err := a.db.Exec(ctx, "alter table cron_jobs add column if not exists timeout_remote_kill_enabled boolean not null default false"); err != nil {
		return fmt.Errorf("migrate timeout_remote_kill_enabled: %w", err)
	}
	if _, err := a.db.Exec(ctx, "alter table job_runs add column if not exists kill_requested_at timestamptz"); err != nil {
		return fmt.Errorf("migrate kill_requested_at: %w", err)
	}
	if _, err := a.db.Exec(ctx, "alter table job_runs add column if not exists kill_ack_at timestamptz"); err != nil {
		return fmt.Errorf("migrate kill_ack_at: %w", err)
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
	if _, err := a.db.Exec(ctx, `
delete from absence_alerts a using absence_alerts b
where a.job_id = b.job_id and a.scheduled_fire_at = b.scheduled_fire_at and a.id > b.id`); err != nil {
		return fmt.Errorf("absence_alerts dedup: %w", err)
	}
	if _, err := a.db.Exec(ctx, `create unique index if not exists absence_alerts_job_scheduled_unique on absence_alerts (job_id, scheduled_fire_at)`); err != nil {
		return fmt.Errorf("absence_alerts unique: %w", err)
	}
	for _, q := range []string{
		"alter table cron_jobs add column if not exists success_exit_code int not null default 0",
		"alter table cron_jobs add column if not exists runs_ingest_token text",
		"alter table job_runs add column if not exists duration_ms int",
		"alter table job_runs add column if not exists stdout_truncated boolean not null default false",
		"alter table job_runs add column if not exists stderr_truncated boolean not null default false",
	} {
		if _, err := a.db.Exec(ctx, q); err != nil {
			return fmt.Errorf("migrate execution log capture: %w", err)
		}
	}
	if _, err := a.db.Exec(ctx, `update cron_jobs set runs_ingest_token = md5(random()::text || id::text || clock_timestamp()::text) || md5(random()::text || id::text || random()::text) where runs_ingest_token is null or runs_ingest_token = ''`); err != nil {
		return fmt.Errorf("backfill runs_ingest_token: %w", err)
	}
	if _, err := a.db.Exec(ctx, "alter table cron_jobs alter column runs_ingest_token set not null"); err != nil {
		return fmt.Errorf("runs_ingest_token not null: %w", err)
	}
	if _, err := a.db.Exec(ctx, "create unique index if not exists cron_jobs_runs_ingest_token_key on cron_jobs (runs_ingest_token)"); err != nil {
		return fmt.Errorf("runs_ingest_token unique: %w", err)
	}
	monitoredServers := `
create table if not exists monitored_servers (
  id uuid primary key,
  name text not null,
  heartbeat_token text not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  last_unreachable_alert_at timestamptz
);
create unique index if not exists monitored_servers_heartbeat_token_key on monitored_servers (heartbeat_token);
`
	if _, err := a.db.Exec(ctx, monitoredServers); err != nil {
		return fmt.Errorf("monitored_servers: %w", err)
	}
	if _, err := a.db.Exec(ctx, "alter table notification_settings add column if not exists notify_server_unreachable boolean not null default true"); err != nil {
		return fmt.Errorf("migrate notify_server_unreachable: %w", err)
	}
	crontabSnap := `
create table if not exists crontab_snapshots (
  id uuid primary key,
  monitored_server_id uuid not null references monitored_servers(id) on delete cascade,
  content_hash text not null,
  content text not null default '',
  user_context text not null default '',
  capture_error text,
  diff_from_previous text,
  created_at timestamptz not null default now()
);
create index if not exists crontab_snapshots_server_created_idx on crontab_snapshots (monitored_server_id, created_at desc);
`
	if _, err := a.db.Exec(ctx, crontabSnap); err != nil {
		return fmt.Errorf("crontab_snapshots: %w", err)
	}
	if _, err := a.db.Exec(ctx, "alter table monitored_servers add column if not exists crontab_poll_interval_seconds int not null default 300"); err != nil {
		return fmt.Errorf("migrate crontab_poll_interval_seconds: %w", err)
	}
	if _, err := a.db.Exec(ctx, "alter table notification_settings add column if not exists notify_crontab_changed boolean not null default true"); err != nil {
		return fmt.Errorf("migrate notify_crontab_changed: %w", err)
	}
	if _, err := a.db.Exec(ctx, "alter table job_runs add column if not exists run_trigger text not null default 'scheduled'"); err != nil {
		return fmt.Errorf("migrate job_runs run_trigger: %w", err)
	}
	if _, err := a.db.Exec(ctx, "alter table cron_jobs add column if not exists enabled boolean not null default true"); err != nil {
		return fmt.Errorf("migrate cron_jobs enabled: %w", err)
	}
	jobAudit := `
create table if not exists job_config_audit (
  id uuid primary key,
  job_id uuid not null references cron_jobs(id) on delete cascade,
  changed_at timestamptz not null default now(),
  actor text not null default '',
  changes jsonb not null default '{}'::jsonb
);
create index if not exists job_config_audit_job_changed_idx on job_config_audit (job_id, changed_at desc);
`
	if _, err := a.db.Exec(ctx, jobAudit); err != nil {
		return fmt.Errorf("job_config_audit: %w", err)
	}
	jobEnvVars := `
create table if not exists job_env_vars (
  id uuid primary key,
  job_id uuid not null references cron_jobs(id) on delete cascade,
  name text not null,
  ciphertext bytea not null,
  updated_at timestamptz not null default now(),
  unique (job_id, name)
);
create index if not exists job_env_vars_job_id_idx on job_env_vars (job_id);
`
	if _, err := a.db.Exec(ctx, jobEnvVars); err != nil {
		return fmt.Errorf("job_env_vars: %w", err)
	}
	feat14 := `
alter table cron_jobs add column if not exists alert_use_default_channels boolean not null default true;
create table if not exists alert_channels (
  id uuid primary key,
  kind text not null,
  label text not null default '',
  enabled boolean not null default true,
  config_ciphertext bytea not null,
  created_at timestamptz not null default now(),
  constraint alert_channels_kind_chk check (kind in ('slack_webhook', 'generic_webhook', 'sms_twilio'))
);
create index if not exists alert_channels_enabled_idx on alert_channels (enabled) where enabled = true;
create table if not exists job_alert_channels (
  job_id uuid not null references cron_jobs(id) on delete cascade,
  channel_id uuid not null,
  primary key (job_id, channel_id)
);
create index if not exists job_alert_channels_job_idx on job_alert_channels (job_id);
create table if not exists alert_delivery_log (
  id uuid primary key,
  created_at timestamptz not null default now(),
  channel_id uuid references alert_channels(id) on delete set null,
  channel_kind text not null,
  channel_label text not null default '',
  alert_type text not null,
  job_id uuid references cron_jobs(id) on delete set null,
  run_id uuid references job_runs(id) on delete set null,
  server_hint text not null default '',
  status text not null,
  attempts int not null default 1,
  error_message text not null default '',
  constraint alert_delivery_log_status_chk check (status in ('sent', 'failed'))
);
create index if not exists alert_delivery_log_created_idx on alert_delivery_log (created_at desc);
create index if not exists alert_delivery_log_job_idx on alert_delivery_log (job_id, created_at desc);
`
	if _, err := a.db.Exec(ctx, feat14); err != nil {
		return fmt.Errorf("feat14 alert channels: %w", err)
	}
	apiKeysTable := `
create table if not exists api_keys (
  id uuid primary key,
  name text not null default '',
  key_prefix text not null,
  key_hash text not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists api_keys_key_prefix_key on api_keys (key_prefix);
create index if not exists api_keys_revoked_idx on api_keys (revoked_at);
`
	if _, err := a.db.Exec(ctx, apiKeysTable); err != nil {
		return fmt.Errorf("api_keys: %w", err)
	}
	accountBilling := `
create table if not exists account_billing (
  id smallint primary key check (id = 1),
  plan_slug text not null default 'free',
  updated_at timestamptz not null default now()
);
insert into account_billing (id, plan_slug) values (1, 'free')
  on conflict (id) do nothing;
`
	if _, err := a.db.Exec(ctx, accountBilling); err != nil {
		return fmt.Errorf("account_billing: %w", err)
	}
	if _, err := a.db.Exec(ctx, "alter table account_billing add column if not exists onboarding_completed_at timestamptz"); err != nil {
		return fmt.Errorf("migrate onboarding_completed_at: %w", err)
	}
	if _, err := a.db.Exec(ctx, "alter table account_billing add column if not exists onboarding_skipped boolean not null default false"); err != nil {
		return fmt.Errorf("migrate onboarding_skipped: %w", err)
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

// jobOverallStatus maps heartbeat classification + latest run into one dashboard label (FEAT-04).
func jobOverallStatus(hasHeartbeat bool, hbStatus, lastRunStatus string) string {
	ls := strings.ToLower(strings.TrimSpace(lastRunStatus))
	if hasHeartbeat {
		switch hbStatus {
		case heartbeat.StatusHealthy:
			return "healthy"
		case heartbeat.StatusLate:
			return "late"
		case heartbeat.StatusDead:
			return "failed"
		case heartbeat.StatusNever:
			return dashboardStatusFromLastRun(ls)
		default:
			return dashboardStatusFromLastRun(ls)
		}
	}
	return dashboardStatusFromLastRun(ls)
}

func dashboardStatusFromLastRun(ls string) string {
	switch ls {
	case "success":
		return "healthy"
	case "failure", "timed_out":
		return "failed"
	case "running":
		return "running"
	default:
		return "never_run"
	}
}

func (a *app) listJobs(c *gin.Context) {
	rows, err := a.db.Query(c,
		`select j.id,j.name,j.schedule,j.timezone,j.working_dir,j.command,j.comment,j.logging_enabled,j.timeout_seconds,coalesce(j.timeout_remote_kill_enabled,false),j.enabled,j.created_at,
			j.heartbeat_token, j.heartbeat_grace_seconds, j.last_heartbeat_at,
			j.runs_ingest_token, coalesce(j.success_exit_code,0),
			coalesce(j.alert_use_default_channels,true),
			(select string_agg(channel_id::text, ',' order by channel_id) from job_alert_channels jm where jm.job_id = j.id),
			lr.status, lr.started_at, lr.duration_ms
		 from cron_jobs j
		 left join lateral (
		   select status, started_at, duration_ms
		   from job_runs
		   where job_id = j.id
		   order by started_at desc
		   limit 1
		 ) lr on true
		 order by j.created_at desc`)
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
		var remoteKill bool
		var jobEnabled bool
		var created time.Time
		var hbToken, ingestTok string
		var grace, successExit int
		var lastHB *time.Time
		var lastN sql.NullTime
		var useDefAlert bool
		var alertChCSV sql.NullString
		var lrStatus sql.NullString
		var lrStarted sql.NullTime
		var lrDur sql.NullInt64
		if err := rows.Scan(&id, &name, &schedule, &timezone, &workingDir, &cmd, &comment, &logEnabled, &timeout, &remoteKill, &jobEnabled, &created,
			&hbToken, &grace, &lastN, &ingestTok, &successExit,
			&useDefAlert, &alertChCSV,
			&lrStatus, &lrStarted, &lrDur); err != nil {
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
		hasHB := strings.TrimSpace(hbToken) != ""
		lastRunStatus := ""
		if lrStatus.Valid {
			lastRunStatus = lrStatus.String
		}
		dash := jobOverallStatus(hasHB, st.Status, lastRunStatus)
		if !jobEnabled {
			dash = "paused"
		}
		alertIDs := make([]string, 0)
		if alertChCSV.Valid && strings.TrimSpace(alertChCSV.String) != "" {
			for _, p := range strings.Split(alertChCSV.String, ",") {
				p = strings.TrimSpace(p)
				if p != "" {
					alertIDs = append(alertIDs, p)
				}
			}
		}
		row := gin.H{
			"id": id, "name": name, "schedule": schedule, "timezone": timezone, "working_directory": workingDir,
			"command": cmd, "comment": comment, "logging_enabled": logEnabled,
			"timeout_seconds": timeout, "timeout_remote_kill_enabled": remoteKill, "enabled": jobEnabled, "created_at": created,
			"heartbeat_token":              hbToken,
			"heartbeat_grace_seconds":      grace,
			"last_heartbeat_at":            lastAt,
			"heartbeat_status":             st.Status,
			"heartbeat_deadline_at":        st.Deadline.UTC().Format(time.RFC3339Nano),
			"heartbeat_prev_fire_at":       st.PrevFire.UTC().Format(time.RFC3339Nano),
			"heartbeat_interval_seconds":   st.IntervalSeconds,
			"heartbeat_first_ping_due_by":  st.FirstPingDueBy.UTC().Format(time.RFC3339Nano),
			"runs_ingest_token":            ingestTok,
			"success_exit_code":            successExit,
			"dashboard_status":             dash,
			"alert_use_default_channels":   useDefAlert,
			"alert_channel_ids":            alertIDs,
		}
		if lrStatus.Valid {
			row["last_run_status"] = lrStatus.String
		} else {
			row["last_run_status"] = nil
		}
		if lrStarted.Valid {
			row["last_run_at"] = lrStarted.Time.UTC().Format(time.RFC3339Nano)
		} else {
			row["last_run_at"] = nil
		}
		if lrDur.Valid {
			row["last_run_duration_ms"] = int(lrDur.Int64)
		} else {
			row["last_run_duration_ms"] = nil
		}
		out = append(out, row)
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
	timezone, workingDir, grace, successExit, errMsg := normalizeJobPayload(&p)
	if errMsg != "" {
		c.JSON(400, gin.H{"error": errMsg})
		return
	}
	if a.pricing != nil {
		if err := a.pricing.CheckCreateMonitor(c.Request.Context()); err != nil {
			if errors.Is(err, pricing.ErrMonitorLimit) {
				c.JSON(http.StatusConflict, gin.H{"error": "Monitor limit reached for your current plan. Delete a job or upgrade."})
				return
			}
			slog.Error("createJob billing check", "err", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to verify plan limits"})
			return
		}
	}
	hbTok, err := heartbeat.GenerateToken()
	if err != nil {
		slog.Error("createJob heartbeat token", "err", err)
		c.JSON(500, gin.H{"error": "failed to create job"})
		return
	}
	ingestTok, err := heartbeat.GenerateToken()
	if err != nil {
		slog.Error("createJob runs ingest token", "err", err)
		c.JSON(500, gin.H{"error": "failed to create job"})
		return
	}
	jobID := uuid.New()
	en := jobPayloadEnabled(&p)
	_, err = a.db.Exec(c,
		`insert into cron_jobs(id,name,schedule,timezone,working_dir,command,comment,logging_enabled,timeout_seconds,heartbeat_token,heartbeat_grace_seconds,runs_ingest_token,success_exit_code,enabled,timeout_remote_kill_enabled)
		 values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
		jobID, p.Name, p.Schedule, timezone, workingDir, p.Command, p.Comment, p.LoggingEnabled, p.TimeoutSeconds, hbTok, grace, ingestTok, successExit, en, p.TimeoutRemoteKillEnabled,
	)
	if err != nil {
		slog.Error("createJob db insert", "err", err)
		c.JSON(500, gin.H{"error": "failed to create job"})
		return
	}
	c.JSON(201, gin.H{"ok": true, "id": jobID.String(), "heartbeat_token": hbTok})
}

func (a *app) updateJob(c *gin.Context) {
	id := c.Param("id")
	jobUUID, err := uuid.Parse(id)
	if err != nil {
		c.JSON(400, gin.H{"error": "invalid job ID format"})
		return
	}

	var p jobPayload
	if err := c.BindJSON(&p); err != nil {
		c.JSON(400, gin.H{"error": "invalid JSON payload"})
		return
	}
	timezone, workingDir, grace, successExit, errMsg := normalizeJobPayload(&p)
	if errMsg != "" {
		c.JSON(400, gin.H{"error": errMsg})
		return
	}
	enNew := jobPayloadEnabled(&p)
	if jerr := a.applyJobUpdate(c.Request.Context(), id, jobUUID, &p, timezone, workingDir, grace, successExit, enNew); jerr != nil {
		c.JSON(jerr.Status, gin.H{"error": jerr.Message})
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

func (a *app) listServers(c *gin.Context) {
	rows, err := a.db.Query(c.Request.Context(), `select id, name, created_at, last_seen_at, coalesce(crontab_poll_interval_seconds,300) from monitored_servers order by name asc`)
	if err != nil {
		slog.Error("listServers query", "err", err)
		c.JSON(500, gin.H{"error": "failed to list servers"})
		return
	}
	defer rows.Close()
	now := time.Now()
	out := make([]gin.H, 0)
	for rows.Next() {
		var id uuid.UUID
		var name string
		var created time.Time
		var lastN sql.NullTime
		var pollSec int
		if err := rows.Scan(&id, &name, &created, &lastN, &pollSec); err != nil {
			slog.Error("listServers scan", "err", err)
			c.JSON(500, gin.H{"error": "failed to read server row"})
			return
		}
		var lastPtr *time.Time
		if lastN.Valid {
			t := lastN.Time
			lastPtr = &t
		}
		var lastSeenJSON any
		if lastPtr != nil {
			lastSeenJSON = lastPtr.UTC().Format(time.RFC3339Nano)
		}
		out = append(out, gin.H{
			"id":                            id.String(),
			"name":                          name,
			"created_at":                    created.UTC().Format(time.RFC3339Nano),
			"last_seen_at":                  lastSeenJSON,
			"health":                        serverReachabilityHealth(created, lastPtr, now),
			"crontab_poll_interval_seconds": pollSec,
		})
	}
	if err := rows.Err(); err != nil {
		slog.Error("listServers rows", "err", err)
		c.JSON(500, gin.H{"error": "failed to list servers"})
		return
	}
	c.JSON(200, out)
}

func (a *app) createServer(c *gin.Context) {
	var p serverPayload
	if err := c.BindJSON(&p); err != nil {
		c.JSON(400, gin.H{"error": "invalid JSON payload"})
		return
	}
	p.Name = strings.TrimSpace(p.Name)
	if p.Name == "" {
		c.JSON(400, gin.H{"error": "server name is required"})
		return
	}
	tok, err := heartbeat.GenerateToken()
	if err != nil {
		slog.Error("createServer token", "err", err)
		c.JSON(500, gin.H{"error": "failed to register server"})
		return
	}
	id := uuid.New()
	_, err = a.db.Exec(c.Request.Context(), `insert into monitored_servers(id,name,heartbeat_token) values($1,$2,$3)`, id, p.Name, tok)
	if err != nil {
		slog.Error("createServer insert", "err", err)
		c.JSON(500, gin.H{"error": "failed to register server"})
		return
	}
	c.JSON(201, gin.H{
		"ok":                            true,
		"id":                            id.String(),
		"heartbeat_token":               tok,
		"crontab_poll_interval_seconds": 300,
	})
}

func (a *app) updateServer(c *gin.Context) {
	id := c.Param("id")
	if _, err := uuid.Parse(id); err != nil {
		c.JSON(400, gin.H{"error": "invalid server ID format"})
		return
	}
	var p serverUpdatePayload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(400, gin.H{"error": "invalid JSON body"})
		return
	}
	if p.CrontabPollIntervalSeconds == nil {
		c.JSON(400, gin.H{"error": "crontab_poll_interval_seconds is required"})
		return
	}
	sec := *p.CrontabPollIntervalSeconds
	if sec < 60 || sec > 86400 {
		c.JSON(400, gin.H{"error": "crontab_poll_interval_seconds must be between 60 and 86400"})
		return
	}
	tag, err := a.db.Exec(c.Request.Context(), `update monitored_servers set crontab_poll_interval_seconds=$2 where id=$1`, id, sec)
	if err != nil {
		slog.Error("updateServer db", "id", id, "err", err)
		c.JSON(500, gin.H{"error": "failed to update server"})
		return
	}
	if tag.RowsAffected() == 0 {
		c.JSON(404, gin.H{"error": "server not found"})
		return
	}
	c.JSON(200, gin.H{"ok": true, "crontab_poll_interval_seconds": sec})
}

func (a *app) deleteServer(c *gin.Context) {
	id := c.Param("id")
	if _, err := uuid.Parse(id); err != nil {
		c.JSON(400, gin.H{"error": "invalid server ID format"})
		return
	}
	tag, err := a.db.Exec(c.Request.Context(), `delete from monitored_servers where id=$1`, id)
	if err != nil {
		slog.Error("deleteServer db", "id", id, "err", err)
		c.JSON(500, gin.H{"error": "failed to delete server"})
		return
	}
	if tag.RowsAffected() == 0 {
		c.JSON(404, gin.H{"error": "server not found"})
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
	var timeout, successExit int
	err := a.db.QueryRow(c,
		"select id,name,working_dir,command,logging_enabled,timeout_seconds,coalesce(success_exit_code,0) from cron_jobs where id=$1", id,
	).Scan(&jobID, &name, &workingDir, &command, &loggingEnabled, &timeout, &successExit)
	if err != nil {
		c.JSON(404, gin.H{"error": "job not found"})
		return
	}
	if loggingEnabled {
		runID := uuid.New()
		startedRun := time.Now()
		if _, err := a.db.Exec(c,
			"insert into job_runs(id,job_id,job_name,command,status,started_at,run_trigger) values($1,$2,$3,$4,'running',$5,$6)",
			runID, jobID, name, command, startedRun, "manual",
		); err != nil {
			slog.Error("runJobManual insert run record", "job", name, "err", err)
			c.JSON(500, gin.H{"error": "failed to start job"})
			return
		}
		go func() {
			if _, err := a.executeJob(context.Background(), jobID, name, workingDir, command, timeout, &runID, "manual", successExit, startedRun); err != nil {
				slog.Error("background job execution failed", "job", name, "err", err)
			}
		}()
		c.JSON(202, gin.H{"status": "started_in_background", "run_id": runID})
		return
	}
	runID, err := a.executeJob(c.Request.Context(), jobID, name, workingDir, command, timeout, nil, "manual", successExit, time.Now())
	if err != nil {
		slog.Error("manual job execution failed", "job", name, "err", err)
		c.JSON(500, gin.H{"error": "job execution failed: " + err.Error()})
		return
	}
	c.JSON(200, gin.H{"run_id": runID})
}

func (a *app) executeJob(ctx context.Context, jobID uuid.UUID, name, workingDir, command string, timeoutSeconds int, existingRunID *uuid.UUID, trigger string, successExitCode int, runStartedAt time.Time) (uuid.UUID, error) {
	runID := uuid.New()
	var runStart time.Time
	if existingRunID != nil {
		runID = *existingRunID
		if runStartedAt.IsZero() {
			if err := a.db.QueryRow(ctx, `select started_at from job_runs where id=$1`, runID).Scan(&runStart); err != nil {
				return uuid.Nil, fmt.Errorf("load run start: %w", err)
			}
		} else {
			runStart = runStartedAt
		}
	} else {
		started := runStartedAt
		if started.IsZero() {
			started = time.Now()
		}
		runStart = started
		if _, err := a.db.Exec(ctx,
			"insert into job_runs(id,job_id,job_name,command,status,started_at,run_trigger) values($1,$2,$3,$4,'running',$5,$6)",
			runID, jobID, name, command, runStart, trigger,
		); err != nil {
			return uuid.Nil, fmt.Errorf("insert run record: %w", err)
		}
	}
	a.publish(runID.String(), `{"status":"running"}`)

	var execCtx context.Context
	var cancel context.CancelFunc
	if timeoutSeconds > 0 {
		execCtx, cancel = context.WithTimeout(ctx, time.Duration(timeoutSeconds)*time.Second)
	} else {
		execCtx = ctx
		cancel = func() {}
	}
	defer cancel()

	envMap, envErr := a.loadJobEnvDecrypted(ctx, jobID)
	if envErr != nil {
		a.markRunFailed(runID, "environment variables unavailable", envErr.Error())
		return uuid.Nil, fmt.Errorf("load job env: %w", envErr)
	}
	vals := jobEnvValuesForRedact(envMap)

	cmd := exec.CommandContext(execCtx, "bash", "-lc", command)
	cmd.Env = os.Environ()
	for k, v := range envMap {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
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
			red := jobenv.RedactValues(line, vals, 4)
			buf.WriteString(red + "\n")
			msg, _ := json.Marshal(gin.H{"status": "running", "stream": prefix, "line": red})
			a.publish(runID.String(), string(msg))
		}
	}
	wg.Add(2)
	go streamPipe("stdout", stdoutPipe, &outBuf)
	go streamPipe("stderr", stderrPipe, &errBuf)

	waitErr := cmd.Wait()
	wg.Wait()

	stdout := jobenv.RedactValues(outBuf.String(), vals, 4)
	stderr := jobenv.RedactValues(errBuf.String(), vals, 4)
	exitCode := 0
	if waitErr != nil {
		if exitErr, ok := waitErr.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else if !errors.Is(waitErr, context.Canceled) && !errors.Is(waitErr, context.DeadlineExceeded) {
			exitCode = 1
		}
	}

	ended := time.Now()
	durationMs := int(ended.Sub(runStart) / time.Millisecond)

	status := "success"
	failureReason := ""
	failureFix := ""
	if timeoutSeconds > 0 && errors.Is(execCtx.Err(), context.DeadlineExceeded) {
		status = "timed_out"
		failureReason = fmt.Sprintf("Run exceeded configured timeout of %d seconds (duration at timeout: %d ms)", timeoutSeconds, durationMs)
		failureFix = "Increase timeout_seconds, optimize the job, or set timeout to 0 to disable the limit."
	} else if exitCode != successExitCode {
		status = "failure"
		if waitErr == nil {
			failureReason = fmt.Sprintf("Exit code %d (success_exit_code is %d)", exitCode, successExitCode)
			failureFix = "Adjust the command or change success_exit_code for this job."
		} else {
			failureReason, failureFix = diagnoseError(execCtx.Err(), stderr)
		}
	}

	var exitArg any = exitCode
	if status == "timed_out" {
		exitArg = nil
	}
	if _, dbErr := a.db.Exec(context.Background(),
		`update job_runs set status=$2, exit_code=$3, stdout=$4, stderr=$5, ended_at=$6, failure_reason=$7, failure_fix=$8, duration_ms=$9, stdout_truncated=false, stderr_truncated=false where id=$1`,
		runID, status, exitArg, stdout, stderr, ended, failureReason, failureFix, durationMs,
	); dbErr != nil {
		slog.Error("executeJob update run", "run_id", runID, "err", dbErr)
		return uuid.Nil, fmt.Errorf("update run record: %w", dbErr)
	}

	ev := gin.H{"status": status, "stdout": stdout, "stderr": stderr}
	if status == "timed_out" {
		ev["exit_code"] = nil
	} else {
		ev["exit_code"] = exitCode
	}
	event, _ := json.Marshal(ev)
	a.publish(runID.String(), string(event))
	a.notifyRunCompletedBackground(runID)
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
	a.notifyRunCompletedBackground(runID)
}

func (a *app) notifyRunCompletedBackground(runID uuid.UUID) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		defer cancel()
		var jobIDStr sql.NullString
		var jobName, command, status, failureReason, stdout, stderr, runTrigger string
		var exitCode *int
		err := a.db.QueryRow(ctx,
			`select coalesce(job_id::text,''), job_name, command, status, exit_code, coalesce(failure_reason,''), coalesce(stdout,''), coalesce(stderr,''), coalesce(nullif(trim(run_trigger),''),'scheduled') from job_runs where id=$1`,
			runID,
		).Scan(&jobIDStr, &jobName, &command, &status, &exitCode, &failureReason, &stdout, &stderr, &runTrigger)
		if err != nil {
			slog.Error("notify load run", "run_id", runID, "err", err)
			return
		}
		jobUUID := uuid.Nil
		if jobIDStr.Valid && strings.TrimSpace(jobIDStr.String) != "" {
			if u, perr := uuid.Parse(strings.TrimSpace(jobIDStr.String)); perr == nil {
				jobUUID = u
			}
		}
		s, err := notify.Load(ctx, a.db)
		if err != nil || !notify.ShouldNotifyRun(s, runTrigger, status) || !notify.TransportAvailable(ctx, a.db, s) {
			return
		}
		subj, body := notify.FormatRunCompleted(jobName, command, status, runID.String(), exitCode, failureReason, stdout, stderr)
		disp := a.dispatcher()
		ts := time.Now().UTC().Format(time.RFC3339Nano)
		payload := notify.AlertPayload{
			AlertType:    notify.AlertTypeRunCompleted,
			JobName:      jobName,
			Status:       status,
			ErrorMessage: failureReason,
			Timestamp:    ts,
			JobURL:       disp.JobDeepLink(jobUUID),
			RunURL:       disp.RunDeepLink(jobUUID),
		}
		rid := runID
		disp.Dispatch(ctx, s, jobUUID, &rid, notify.AlertTypeRunCompleted, "", payload, subj, body, false, notify.DeliverableSMTP(s))
	}()
}

// durationMsSQL is a SQL expression for effective run duration in milliseconds (ended runs only).
const durationMsSQL = `coalesce(duration_ms, case when ended_at is not null then floor(extract(epoch from (ended_at - started_at)) * 1000)::int else null end)`

// logPreviewSQL is a single-column expression: stdout normalized to spaces, truncated (FEAT-05).
const logPreviewSQL160 = `left(regexp_replace(regexp_replace(regexp_replace(coalesce(stdout,''), chr(9), ' ', 'g'), chr(10), ' ', 'g'), chr(13), ' ', 'g'), 160)`
const logPreviewSQL500 = `left(regexp_replace(regexp_replace(regexp_replace(coalesce(stdout,''), chr(9), ' ', 'g'), chr(10), ' ', 'g'), chr(13), ' ', 'g'), 500)`

type runsFilterParams struct {
	Status        string
	Search        string
	JobID         string
	StartedAfter  *time.Time
	StartedBefore *time.Time
	MinDurMs      *int
	MaxDurMs      *int
}

// parseRunsFilterParams parses shared query params for listRuns and exportRunsCSV.
func parseRunsFilterParams(c *gin.Context) (runsFilterParams, *gin.H) {
	var p runsFilterParams
	p.Status = strings.TrimSpace(strings.ToLower(c.Query("status")))
	p.Search = strings.TrimSpace(c.Query("search"))
	p.JobID = strings.TrimSpace(c.Query("job_id"))
	sa, err1 := parseRFC3339Query(c.Query("started_after"))
	if err1 != nil {
		return p, &gin.H{"error": "invalid started_after (use RFC3339)"}
	}
	p.StartedAfter = sa
	sb, err2 := parseRFC3339Query(c.Query("started_before"))
	if err2 != nil {
		return p, &gin.H{"error": "invalid started_before (use RFC3339)"}
	}
	p.StartedBefore = sb
	minDur, err3 := parseOptionalIntQuery(c.Query("min_duration_ms"), 0, 86400000)
	if err3 != nil {
		return p, &gin.H{"error": "invalid min_duration_ms"}
	}
	p.MinDurMs = minDur
	maxDur, err4 := parseOptionalIntQuery(c.Query("max_duration_ms"), 0, 86400000*7)
	if err4 != nil {
		return p, &gin.H{"error": "invalid max_duration_ms"}
	}
	p.MaxDurMs = maxDur
	return p, nil
}

// csvEscapeField quotes a CSV field per RFC 4180 when it contains special characters (for tests / helpers).
func csvEscapeField(s string) string {
	if !strings.ContainsAny(s, ",\"\r\n\t") {
		return s
	}
	return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
}

// buildRunsWhere returns SQL fragments for filtering job_runs. Maps UI status "failed" to failure and timed_out.
func buildRunsWhere(status, search, jobID string, startedAfter, startedBefore *time.Time, minDurMs, maxDurMs *int) ([]string, []any, int, error) {
	where := make([]string, 0, 8)
	args := make([]any, 0, 12)
	argN := 1
	status = strings.TrimSpace(strings.ToLower(status))
	if status == "failed" {
		where = append(where, fmt.Sprintf("(lower(status) = $%d or lower(status) = $%d)", argN, argN+1))
		args = append(args, "failure", "timed_out")
		argN += 2
	} else if status != "" && status != "all" {
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
	if startedAfter != nil {
		where = append(where, fmt.Sprintf("started_at >= $%d", argN))
		args = append(args, *startedAfter)
		argN++
	}
	if startedBefore != nil {
		where = append(where, fmt.Sprintf("started_at <= $%d", argN))
		args = append(args, *startedBefore)
		argN++
	}
	if minDurMs != nil {
		where = append(where, fmt.Sprintf("ended_at is not null and (%s) >= $%d", durationMsSQL, argN))
		args = append(args, *minDurMs)
		argN++
	}
	if maxDurMs != nil {
		where = append(where, fmt.Sprintf("ended_at is not null and (%s) <= $%d", durationMsSQL, argN))
		args = append(args, *maxDurMs)
		argN++
	}
	return where, args, argN, nil
}

func parseRFC3339Query(raw string) (*time.Time, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	t, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		t, err = time.Parse(time.RFC3339, raw)
	}
	if err != nil {
		return nil, err
	}
	utc := t.UTC()
	return &utc, nil
}

func parseOptionalIntQuery(raw string, min, max int) (*int, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	v, err := strconv.Atoi(raw)
	if err != nil {
		return nil, err
	}
	if v < min || v > max {
		return nil, fmt.Errorf("out of range")
	}
	return &v, nil
}

func runsIngestAuthToken(c *gin.Context) string {
	if v := strings.TrimSpace(c.GetHeader("X-Runs-Ingest-Token")); v != "" {
		return v
	}
	h := strings.TrimSpace(c.GetHeader("Authorization"))
	const prefix = "Bearer "
	if len(h) > len(prefix) && strings.EqualFold(h[:len(prefix)], prefix) {
		return strings.TrimSpace(h[len(prefix):])
	}
	return ""
}

func (a *app) postJobRunIngest(c *gin.Context) {
	idParam := strings.TrimSpace(c.Param("id"))
	if _, err := uuid.Parse(idParam); err != nil {
		c.JSON(400, gin.H{"error": "invalid job ID format"})
		return
	}
	tok := runsIngestAuthToken(c)
	if tok == "" {
		c.JSON(401, gin.H{"error": "missing ingest token: use Authorization: Bearer <token> or X-Runs-Ingest-Token"})
		return
	}
	body, err := io.ReadAll(io.LimitReader(c.Request.Body, runsingest.MaxBodyBytes+1))
	if err != nil {
		c.JSON(400, gin.H{"error": "could not read request body"})
		return
	}
	if len(body) > runsingest.MaxBodyBytes {
		c.JSON(413, gin.H{"error": "request body too large"})
		return
	}
	var payload runsingest.IngestPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		c.JSON(400, gin.H{"error": "invalid JSON payload"})
		return
	}
	var jobID uuid.UUID
	var jname, cmd, storedTok string
	var successExit int
	err = a.db.QueryRow(c.Request.Context(),
		`select id,name,command,coalesce(success_exit_code,0),runs_ingest_token from cron_jobs where id=$1`, idParam,
	).Scan(&jobID, &jname, &cmd, &successExit, &storedTok)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			c.JSON(404, gin.H{"error": "job not found"})
			return
		}
		slog.Error("postJobRunIngest lookup", "err", err)
		c.JSON(500, gin.H{"error": "failed to resolve job"})
		return
	}
	if storedTok != tok {
		c.JSON(401, gin.H{"error": "invalid ingest token"})
		return
	}
	norm, nerr := runsingest.Normalize(payload, time.Now())
	if nerr != nil {
		c.JSON(400, gin.H{"error": nerr.Error()})
		return
	}
	envMap, envErr := a.loadJobEnvDecrypted(c.Request.Context(), jobID)
	if envErr != nil {
		slog.Error("postJobRunIngest job env for redaction", "job_id", jobID, "err", envErr)
		c.JSON(500, gin.H{"error": "could not load job environment for log redaction"})
		return
	}
	vals := jobEnvValuesForRedact(envMap)
	norm.Stdout = jobenv.RedactValues(norm.Stdout, vals, 4)
	norm.Stderr = jobenv.RedactValues(norm.Stderr, vals, 4)
	status := runsingest.StatusForExit(norm.ExitCode, successExit)
	failureReason, failureFix := "", ""
	if status == "failure" {
		failureReason = fmt.Sprintf("Exit code %d (success_exit_code is %d)", norm.ExitCode, successExit)
		failureFix = "Fix the script exit code or change success_exit_code for this job in CronSentinel."
	}
	runID := uuid.New()
	_, err = a.db.Exec(c.Request.Context(),
		`insert into job_runs(id,job_id,job_name,command,status,exit_code,stdout,stderr,started_at,ended_at,failure_reason,failure_fix,duration_ms,stdout_truncated,stderr_truncated,run_trigger)
		 values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
		runID, jobID, jname, cmd, status, norm.ExitCode, norm.Stdout, norm.Stderr, norm.StartedAt, norm.EndedAt, failureReason, failureFix,
		norm.DurationMs, norm.StdoutTruncated, norm.StderrTruncated, "ingest",
	)
	if err != nil {
		slog.Error("postJobRunIngest insert", "err", err)
		c.JSON(500, gin.H{"error": "failed to save run"})
		return
	}
	c.JSON(http.StatusCreated, gin.H{
		"run_id":             runID.String(),
		"stdout_truncated":   norm.StdoutTruncated,
		"stderr_truncated":   norm.StderrTruncated,
	})
}

func jobEnvValuesForRedact(m map[string]string) []string {
	s := make([]string, 0, len(m))
	for _, v := range m {
		s = append(s, v)
	}
	return s
}

func (a *app) loadJobEnvDecrypted(ctx context.Context, jobID uuid.UUID) (map[string]string, error) {
	rows, err := a.db.Query(ctx, `select name, ciphertext from job_env_vars where job_id=$1 order by name`, jobID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string]string)
	for rows.Next() {
		var name string
		var ct []byte
		if err := rows.Scan(&name, &ct); err != nil {
			return nil, err
		}
		plain, err := envcrypto.Decrypt(a.envKey, ct)
		if err != nil {
			return nil, fmt.Errorf("decrypt env %q: %w", name, err)
		}
		out[name] = plain
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func (a *app) listJobEnv(c *gin.Context) {
	idParam := strings.TrimSpace(c.Param("id"))
	jobID, err := uuid.Parse(idParam)
	if err != nil {
		c.JSON(400, gin.H{"error": "invalid job ID format"})
		return
	}
	var jid uuid.UUID
	err = a.db.QueryRow(c.Request.Context(), `select id from cron_jobs where id=$1`, jobID).Scan(&jid)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			c.JSON(404, gin.H{"error": "job not found"})
			return
		}
		slog.Error("listJobEnv job lookup", "err", err)
		c.JSON(500, gin.H{"error": "failed to resolve job"})
		return
	}
	rows, err := a.db.Query(c.Request.Context(), `select name, ciphertext from job_env_vars where job_id=$1 order by name`, jobID)
	if err != nil {
		slog.Error("listJobEnv query", "err", err)
		c.JSON(500, gin.H{"error": "failed to list env vars"})
		return
	}
	defer rows.Close()
	items := make([]gin.H, 0)
	for rows.Next() {
		var name string
		var ct []byte
		if err := rows.Scan(&name, &ct); err != nil {
			slog.Error("listJobEnv scan", "err", err)
			c.JSON(500, gin.H{"error": "failed to read env row"})
			return
		}
		plain, derr := envcrypto.Decrypt(a.envKey, ct)
		masked := "****????"
		sens := false
		if derr == nil {
			masked = jobenv.MaskValue(plain)
			sens = len(jobenv.HeuristicWarnings(plain)) > 0
		} else {
			slog.Warn("listJobEnv decrypt failed", "name", name, "err", derr)
		}
		items = append(items, gin.H{"name": name, "masked_value": masked, "sensitive_hint": sens})
	}
	if err := rows.Err(); err != nil {
		c.JSON(500, gin.H{"error": "failed to iterate env vars"})
		return
	}
	c.JSON(200, gin.H{"items": items})
}

func (a *app) putJobEnv(c *gin.Context) {
	idParam := strings.TrimSpace(c.Param("id"))
	jobID, err := uuid.Parse(idParam)
	if err != nil {
		c.JSON(400, gin.H{"error": "invalid job ID format"})
		return
	}
	var p jobEnvPutPayload
	if err := c.BindJSON(&p); err != nil {
		c.JSON(400, gin.H{"error": "invalid JSON payload"})
		return
	}
	name := strings.TrimSpace(p.Name)
	if err := jobenv.ValidateName(name); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	if utf8.RuneCountInString(p.Value) > jobenv.MaxValueRunes {
		c.JSON(400, gin.H{"error": "value is too long"})
		return
	}
	var total int
	if err := a.db.QueryRow(c.Request.Context(), `select count(*) from job_env_vars where job_id=$1`, jobID).Scan(&total); err != nil {
		slog.Error("putJobEnv count", "err", err)
		c.JSON(500, gin.H{"error": "failed to check env vars"})
		return
	}
	var existingName int
	if err := a.db.QueryRow(c.Request.Context(), `select count(*) from job_env_vars where job_id=$1 and name=$2`, jobID, name).Scan(&existingName); err != nil {
		slog.Error("putJobEnv existing", "err", err)
		c.JSON(500, gin.H{"error": "failed to check env vars"})
		return
	}
	if existingName == 0 && total >= jobenv.MaxVarsPerJob {
		c.JSON(400, gin.H{"error": fmt.Sprintf("at most %d environment variables per job", jobenv.MaxVarsPerJob)})
		return
	}
	var jid uuid.UUID
	if err := a.db.QueryRow(c.Request.Context(), `select id from cron_jobs where id=$1`, jobID).Scan(&jid); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			c.JSON(404, gin.H{"error": "job not found"})
			return
		}
		slog.Error("putJobEnv job lookup", "err", err)
		c.JSON(500, gin.H{"error": "failed to resolve job"})
		return
	}
	ct, encErr := envcrypto.Encrypt(a.envKey, p.Value)
	if encErr != nil {
		slog.Error("putJobEnv encrypt", "err", encErr)
		c.JSON(500, gin.H{"error": "failed to encrypt value"})
		return
	}
	if _, err := a.db.Exec(c.Request.Context(),
		`insert into job_env_vars(id,job_id,name,ciphertext,updated_at) values($1,$2,$3,$4,now())
		 on conflict (job_id, name) do update set ciphertext=excluded.ciphertext, updated_at=now()`,
		uuid.New(), jobID, name, ct,
	); err != nil {
		slog.Error("putJobEnv upsert", "err", err)
		c.JSON(500, gin.H{"error": "failed to save env var"})
		return
	}
	c.JSON(200, gin.H{
		"ok":           true,
		"name":         name,
		"masked_value": jobenv.MaskValue(p.Value),
		"warnings":     jobenv.HeuristicWarnings(p.Value),
	})
}

func (a *app) deleteJobEnv(c *gin.Context) {
	idParam := strings.TrimSpace(c.Param("id"))
	jobID, err := uuid.Parse(idParam)
	if err != nil {
		c.JSON(400, gin.H{"error": "invalid job ID format"})
		return
	}
	name := strings.TrimSpace(c.Query("name"))
	if err := jobenv.ValidateName(name); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	tag, err := a.db.Exec(c.Request.Context(), `delete from job_env_vars where job_id=$1 and name=$2`, jobID, name)
	if err != nil {
		slog.Error("deleteJobEnv", "err", err)
		c.JSON(500, gin.H{"error": "failed to delete env var"})
		return
	}
	if tag.RowsAffected() == 0 {
		c.JSON(404, gin.H{"error": "env var not found"})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

func (a *app) getJobEnvForAgent(c *gin.Context) {
	idParam := strings.TrimSpace(c.Param("id"))
	jobID, err := uuid.Parse(idParam)
	if err != nil {
		c.JSON(400, gin.H{"error": "invalid job ID format"})
		return
	}
	tok := runsIngestAuthToken(c)
	if tok == "" {
		c.JSON(401, gin.H{"error": "missing ingest token: use Authorization: Bearer <token> or X-Runs-Ingest-Token"})
		return
	}
	if !a.envFetchLimiter.Allow(tok, time.Now()) {
		c.JSON(429, gin.H{"error": "rate limited; wait before fetching env again"})
		return
	}
	var storedTok string
	err = a.db.QueryRow(c.Request.Context(), `select runs_ingest_token from cron_jobs where id=$1`, jobID).Scan(&storedTok)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			c.JSON(404, gin.H{"error": "job not found"})
			return
		}
		slog.Error("getJobEnvForAgent lookup", "err", err)
		c.JSON(500, gin.H{"error": "failed to resolve job"})
		return
	}
	if storedTok != tok {
		c.JSON(401, gin.H{"error": "invalid ingest token"})
		return
	}
	m, derr := a.loadJobEnvDecrypted(c.Request.Context(), jobID)
	if derr != nil {
		slog.Error("getJobEnvForAgent decrypt", "err", derr)
		c.JSON(500, gin.H{"error": "could not decrypt environment variables"})
		return
	}
	c.JSON(200, gin.H{"env": m})
}

func (a *app) listRuns(c *gin.Context) {
	limit := parseIntParam(c.Query("limit"), 50, 1, 500)
	offset := parseIntParam(c.Query("offset"), 0, 0, 1_000_000)
	fp, bad := parseRunsFilterParams(c)
	if bad != nil {
		c.JSON(400, *bad)
		return
	}

	where, args, argN, werr := buildRunsWhere(fp.Status, fp.Search, fp.JobID, fp.StartedAfter, fp.StartedBefore, fp.MinDurMs, fp.MaxDurMs)
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
	listSQL := "select id,job_id,job_name,command,status,exit_code,started_at,ended_at,failure_reason,failure_fix,duration_ms,stdout_truncated,stderr_truncated," + logPreviewSQL160 + " as log_preview from job_runs" + whereSQL + " order by started_at desc limit $" + strconv.Itoa(argN) + " offset $" + strconv.Itoa(argN+1)
	rows, err := a.db.Query(c, listSQL, args...)
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
		var dur sql.NullInt64
		var outTrunc, errTrunc bool
		var logPreview string
		if err := rows.Scan(&id, &jobID, &name, &command, &status, &exitCode, &started, &ended, &reason, &fix, &dur, &outTrunc, &errTrunc, &logPreview); err != nil {
			slog.Error("listRuns scan", "err", err)
			c.JSON(500, gin.H{"error": "failed to read run row"})
			return
		}
		row := gin.H{
			"id": id, "job_id": jobID, "job_name": name, "command": command, "status": status,
			"exit_code": exitCode, "started_at": started, "ended_at": ended,
			"failure_reason": reason, "failure_fix": fix,
			"stdout_truncated": outTrunc, "stderr_truncated": errTrunc,
			"log_preview":      logPreview,
		}
		if dur.Valid {
			row["duration_ms"] = int(dur.Int64)
		}
		out = append(out, row)
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

func (a *app) exportRunsCSV(c *gin.Context) {
	fp, bad := parseRunsFilterParams(c)
	if bad != nil {
		c.JSON(400, *bad)
		return
	}
	exportLimit := parseIntParam(c.Query("limit"), 500, 1, 2000)

	where, args, argN, werr := buildRunsWhere(fp.Status, fp.Search, fp.JobID, fp.StartedAfter, fp.StartedBefore, fp.MinDurMs, fp.MaxDurMs)
	if werr != nil {
		c.JSON(400, gin.H{"error": "invalid job ID format"})
		return
	}
	whereSQL := ""
	if len(where) > 0 {
		whereSQL = " where " + strings.Join(where, " and ")
	}
	args = append(args, exportLimit)
	exportSQL := "select id,job_id,job_name,started_at,ended_at,status,exit_code,failure_reason,duration_ms," + logPreviewSQL500 + " as log_preview from job_runs" + whereSQL + " order by started_at desc limit $" + strconv.Itoa(argN)
	rows, err := a.db.Query(c, exportSQL, args...)
	if err != nil {
		slog.Error("exportRunsCSV query", "err", err)
		c.JSON(500, gin.H{"error": "failed to query runs"})
		return
	}
	defer rows.Close()

	c.Header("Content-Type", "text/csv; charset=utf-8")
	c.Header("Content-Disposition", `attachment; filename="runs-export.csv"`)
	c.Status(http.StatusOK)

	w := csv.NewWriter(c.Writer)
	header := []string{"id", "job_id", "job_name", "started_at", "ended_at", "duration_ms", "status", "exit_code", "failure_reason", "log_preview"}
	if err := w.Write(header); err != nil {
		slog.Error("exportRunsCSV header", "err", err)
		return
	}
	for rows.Next() {
		var id uuid.UUID
		var jobID *uuid.UUID
		var name, status, reason, logPreview string
		var exitCode *int
		var started time.Time
		var ended *time.Time
		var dur sql.NullInt64
		if err := rows.Scan(&id, &jobID, &name, &started, &ended, &status, &exitCode, &reason, &dur, &logPreview); err != nil {
			slog.Error("exportRunsCSV scan", "err", err)
			return
		}
		jobIDStr := ""
		if jobID != nil {
			jobIDStr = jobID.String()
		}
		exitStr := ""
		if exitCode != nil {
			exitStr = strconv.Itoa(*exitCode)
		}
		durMs := ""
		if dur.Valid {
			durMs = strconv.FormatInt(dur.Int64, 10)
		} else if ended != nil {
			durMs = strconv.FormatInt(ended.Sub(started).Milliseconds(), 10)
		}
		endedStr := ""
		if ended != nil {
			endedStr = ended.UTC().Format(time.RFC3339Nano)
		}
		rec := []string{
			id.String(),
			jobIDStr,
			name,
			started.UTC().Format(time.RFC3339Nano),
			endedStr,
			durMs,
			status,
			exitStr,
			reason,
			logPreview,
		}
		if err := w.Write(rec); err != nil {
			slog.Error("exportRunsCSV row", "err", err)
			return
		}
	}
	if err := rows.Err(); err != nil {
		slog.Error("exportRunsCSV rows", "err", err)
		return
	}
	w.Flush()
	if err := w.Error(); err != nil {
		slog.Error("exportRunsCSV flush", "err", err)
	}
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
		"notify_heartbeat_missed":     s.NotifyHeartbeatMissed,
		"notify_server_unreachable":   s.NotifyServerUnreachable,
		"notify_crontab_changed":      s.NotifyCrontabChanged,
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
		NotifyHeartbeatMissed   bool  `json:"notify_heartbeat_missed"`
		NotifyServerUnreachable *bool `json:"notify_server_unreachable"`
		NotifyCrontabChanged    *bool `json:"notify_crontab_changed"`
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
	srvUnreach := cur.NotifyServerUnreachable
	if body.NotifyServerUnreachable != nil {
		srvUnreach = *body.NotifyServerUnreachable
	}
	crontabCh := cur.NotifyCrontabChanged
	if body.NotifyCrontabChanged != nil {
		crontabCh = *body.NotifyCrontabChanged
	}
	_, err = a.db.Exec(c.Request.Context(), `
update notification_settings set
  enabled=$1, smtp_host=$2, smtp_port=$3, smtp_username=$4, smtp_password=$5, smtp_tls=$6,
  from_address=$7, to_addresses=$8,
  notify_scheduled_success=$9, notify_scheduled_failure=$10, notify_manual_success=$11, notify_manual_failure=$12,
  notify_heartbeat_missed=$13,
  notify_server_unreachable=$14,
  notify_crontab_changed=$15
where id=1`,
		body.Enabled, strings.TrimSpace(body.SMTPHost), body.SMTPPort, strings.TrimSpace(body.SMTPUsername), pass, body.SMTPTLS,
		strings.TrimSpace(body.FromAddress), strings.TrimSpace(body.ToAddresses),
		body.NotifyScheduledSuccess, body.NotifyScheduledFailure, body.NotifyManualSuccess, body.NotifyManualFailure,
		body.NotifyHeartbeatMissed,
		srvUnreach,
		crontabCh,
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

func (a *app) dispatcher() *notify.Dispatcher {
	d := &notify.Dispatcher{
		DB:         a.db,
		Key:        a.envKey,
		PublicBase: a.publicBaseURL,
		HTTPClient: &http.Client{Timeout: 30 * time.Second},
	}
	if a.pricing != nil {
		d.AlertBudget = a.pricing.CanSendAlert
	}
	return d
}

func (a *app) listAlertChannels(c *gin.Context) {
	items, err := notify.ListAlertChannels(c.Request.Context(), a.db)
	if err != nil {
		slog.Error("listAlertChannels", "err", err)
		c.JSON(500, gin.H{"error": "failed to list channels"})
		return
	}
	c.JSON(200, items)
}

func (a *app) createAlertChannel(c *gin.Context) {
	var raw map[string]json.RawMessage
	if err := c.ShouldBindJSON(&raw); err != nil {
		c.JSON(400, gin.H{"error": "invalid JSON body"})
		return
	}
	var kind string
	if v, ok := raw["kind"]; ok {
		if err := json.Unmarshal(v, &kind); err != nil {
			c.JSON(400, gin.H{"error": "invalid kind"})
			return
		}
	}
	kind = strings.TrimSpace(kind)
	if kind == "" {
		c.JSON(400, gin.H{"error": "kind is required"})
		return
	}
	label := ""
	if v, ok := raw["label"]; ok {
		_ = json.Unmarshal(v, &label)
	}
	enabled := true
	if v, ok := raw["enabled"]; ok {
		_ = json.Unmarshal(v, &enabled)
	}
	id, err := notify.CreateAlertChannel(c.Request.Context(), a.db, a.envKey, kind, label, enabled, raw)
	if err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	c.JSON(201, gin.H{"ok": true, "id": id.String()})
}

func (a *app) patchAlertChannel(c *gin.Context) {
	uid, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "invalid channel id"})
		return
	}
	var raw map[string]json.RawMessage
	if err := c.ShouldBindJSON(&raw); err != nil {
		c.JSON(400, gin.H{"error": "invalid JSON body"})
		return
	}
	var label *string
	if v, ok := raw["label"]; ok {
		var s string
		if err := json.Unmarshal(v, &s); err != nil {
			c.JSON(400, gin.H{"error": "invalid label"})
			return
		}
		label = &s
	}
	var enabled *bool
	if v, ok := raw["enabled"]; ok {
		var b bool
		if err := json.Unmarshal(v, &b); err != nil {
			c.JSON(400, gin.H{"error": "invalid enabled"})
			return
		}
		enabled = &b
	}
	if err := notify.UpdateAlertChannel(c.Request.Context(), a.db, a.envKey, uid, label, enabled, raw); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			c.JSON(404, gin.H{"error": "channel not found"})
			return
		}
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

func (a *app) deleteAlertChannel(c *gin.Context) {
	uid, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "invalid channel id"})
		return
	}
	if err := notify.DeleteAlertChannel(c.Request.Context(), a.db, uid); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			c.JSON(404, gin.H{"error": "channel not found"})
			return
		}
		slog.Error("deleteAlertChannel", "err", err)
		c.JSON(500, gin.H{"error": "failed to delete"})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

func (a *app) postAlertChannelTest(c *gin.Context) {
	uid, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(400, gin.H{"error": "invalid channel id"})
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 60*time.Second)
	defer cancel()
	if err := a.dispatcher().TestChannel(ctx, uid); err != nil {
		c.JSON(502, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true, "status": "sent"})
}

func (a *app) getAlertDeliveryLog(c *gin.Context) {
	limit := parseIntParam(c.Query("limit"), 50, 1, 200)
	var ct *time.Time
	var cid *uuid.UUID
	tStr := strings.TrimSpace(c.Query("cursor_time"))
	idStr := strings.TrimSpace(c.Query("cursor_id"))
	if tStr != "" || idStr != "" {
		if tStr == "" || idStr == "" {
			c.JSON(400, gin.H{"error": "cursor_time and cursor_id are both required when paginating"})
			return
		}
		tm, err := time.Parse(time.RFC3339Nano, tStr)
		if err != nil {
			c.JSON(400, gin.H{"error": "invalid cursor_time (RFC3339 nano)"})
			return
		}
		u, err := uuid.Parse(idStr)
		if err != nil {
			c.JSON(400, gin.H{"error": "invalid cursor_id"})
			return
		}
		ct = &tm
		cid = &u
	}
	items, err := notify.QueryDeliveryLog(c.Request.Context(), a.db, limit, ct, cid)
	if err != nil {
		slog.Error("getAlertDeliveryLog", "err", err)
		c.JSON(500, gin.H{"error": "failed to load delivery log"})
		return
	}
	c.JSON(200, gin.H{"items": items})
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
	where, args, argN, werr := buildRunsWhere(body.Status, body.Search, body.JobID, nil, nil, nil, nil)
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
	var outTrunc, errTrunc bool
	if err := a.db.QueryRow(c, "select stdout,stderr,stdout_truncated,stderr_truncated from job_runs where id=$1", id).Scan(&stdout, &stderr, &outTrunc, &errTrunc); err != nil {
		c.JSON(404, gin.H{"error": "run not found"})
		return
	}
	c.JSON(200, gin.H{
		"stdout": stdout, "stderr": stderr,
		"stdout_truncated": outTrunc, "stderr_truncated": errTrunc,
	})
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
	c.JSON(200, systemreport.Build())
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

// serverHeartbeatSilence is the maximum gap without a ping before a server is unreachable (PRD: 3 minutes).
const serverHeartbeatSilence = 3 * time.Minute

func serverReachabilityHealth(created time.Time, lastSeen *time.Time, now time.Time) string {
	if lastSeen != nil {
		if now.Sub(*lastSeen) < serverHeartbeatSilence {
			return "ok"
		}
		return "stale"
	}
	if now.Sub(created) < serverHeartbeatSilence {
		return "pending"
	}
	return "stale"
}

func serverUnreachableRef(created time.Time, lastSeen *time.Time) time.Time {
	if lastSeen != nil {
		return *lastSeen
	}
	return created
}

const maxHeartbeatPayload = 64 * 1024

// maxCrontabSnapshotJSON caps POST body size for JSON crontab payloads (content up to maxCrontabContentLen).
const maxCrontabSnapshotJSON = 600 * 1024
const maxCrontabContentLen = 512 * 1024

func normalizeCrontabNewlines(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	return strings.ReplaceAll(s, "\r", "\n")
}

func crontabContentSHA256Hex(content string) string {
	sum := sha256.Sum256([]byte(content))
	return hex.EncodeToString(sum[:])
}

func crontabSnapshotFingerprint(captureError, content string) string {
	sum := sha256.Sum256([]byte(captureError + "\n" + content))
	return hex.EncodeToString(sum[:])
}

func buildCrontabDiffSummary(prevErr, prevContent, newErr, newContent string) string {
	pe := strings.TrimSpace(prevErr)
	ne := strings.TrimSpace(newErr)
	switch {
	case pe == "" && ne == "":
		return linediff.Unified(prevContent, newContent)
	case pe != "" && ne == "":
		return "Crontab became readable again.\n\n" + linediff.Unified("", newContent)
	case pe == "" && ne != "":
		return fmt.Sprintf("Crontab capture failed:\n%s\n\n(Line diff vs last successful read:)\n%s", ne, linediff.Unified(prevContent, ""))
	default:
		if pe != ne {
			return fmt.Sprintf("Capture error changed:\n--- before\n%s\n--- after\n%s\n", pe, ne)
		}
		return linediff.Unified(prevContent, newContent)
	}
}

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

func (a *app) postServerHeartbeat(c *gin.Context) {
	rawTok := strings.TrimSpace(c.Param("token"))
	if rawTok == "" {
		c.JSON(404, gin.H{"error": "unknown server heartbeat token"})
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
	var srvID uuid.UUID
	err = a.db.QueryRow(c.Request.Context(), `select id from monitored_servers where heartbeat_token=$1`, rawTok).Scan(&srvID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			c.JSON(404, gin.H{"error": "unknown server heartbeat token"})
			return
		}
		slog.Error("postServerHeartbeat lookup", "err", err)
		c.JSON(500, gin.H{"error": "failed to record server heartbeat"})
		return
	}
	if !a.srvHbLimiter.Allow("srv:"+rawTok, time.Now()) {
		c.JSON(429, gin.H{"error": "rate limited; wait before sending another heartbeat"})
		return
	}
	_, err = a.db.Exec(c.Request.Context(),
		`update monitored_servers set last_seen_at=now(), last_unreachable_alert_at=null where id=$1`, srvID,
	)
	if err != nil {
		slog.Error("postServerHeartbeat update", "err", err)
		c.JSON(500, gin.H{"error": "failed to record server heartbeat"})
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

func (a *app) postCrontabSnapshot(c *gin.Context) {
	rawTok := strings.TrimSpace(c.Param("token"))
	if rawTok == "" {
		c.JSON(404, gin.H{"error": "unknown server token"})
		return
	}
	rawBody, err := io.ReadAll(io.LimitReader(c.Request.Body, maxCrontabSnapshotJSON+1))
	if err != nil {
		c.JSON(400, gin.H{"error": "could not read request body"})
		return
	}
	if len(rawBody) > maxCrontabSnapshotJSON {
		c.JSON(413, gin.H{"error": "payload too large"})
		return
	}
	var p crontabSnapshotPayload
	if err := json.Unmarshal(rawBody, &p); err != nil {
		c.JSON(400, gin.H{"error": "invalid JSON body"})
		return
	}
	content := normalizeCrontabNewlines(strings.ToValidUTF8(p.Content, ""))
	capErr := strings.TrimSpace(p.CaptureError)
	if len(content) > maxCrontabContentLen {
		c.JSON(413, gin.H{"error": "content exceeds maximum length"})
		return
	}
	hexHash := crontabContentSHA256Hex(content)
	if want := strings.TrimSpace(p.ContentHash); want != "" && !strings.EqualFold(want, hexHash) {
		c.JSON(400, gin.H{"error": "content_hash does not match content"})
		return
	}
	ctx := c.Request.Context()
	var srvID uuid.UUID
	var sname string
	err = a.db.QueryRow(ctx, `select id, name from monitored_servers where heartbeat_token=$1`, rawTok).Scan(&srvID, &sname)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			c.JSON(404, gin.H{"error": "unknown server token"})
			return
		}
		slog.Error("postCrontabSnapshot lookup", "err", err)
		c.JSON(500, gin.H{"error": "failed to resolve server"})
		return
	}
	if !a.cronSnapLimiter.Allow("cron:"+rawTok, time.Now()) {
		c.JSON(429, gin.H{"error": "rate limited; wait before sending another snapshot"})
		return
	}

	tx, err := a.db.Begin(ctx)
	if err != nil {
		slog.Error("postCrontabSnapshot begin", "err", err)
		c.JSON(500, gin.H{"error": "failed to start transaction"})
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `select 1 from monitored_servers where id=$1 for update`, srvID); err != nil {
		slog.Error("postCrontabSnapshot lock server", "err", err)
		c.JSON(500, gin.H{"error": "failed to lock server row"})
		return
	}

	var prevID uuid.UUID
	var prevContent string
	var prevErr sql.NullString
	prevHas := false
	err = tx.QueryRow(ctx,
		`select id, content, capture_error from crontab_snapshots where monitored_server_id=$1 order by created_at desc limit 1`,
		srvID,
	).Scan(&prevID, &prevContent, &prevErr)
	if err == nil {
		prevHas = true
	} else if !errors.Is(err, pgx.ErrNoRows) {
		slog.Error("postCrontabSnapshot read prev", "err", err)
		c.JSON(500, gin.H{"error": "failed to read previous snapshot"})
		return
	}

	fpNew := crontabSnapshotFingerprint(capErr, content)
	fpPrev := ""
	if prevHas {
		ps := ""
		if prevErr.Valid {
			ps = prevErr.String
		}
		fpPrev = crontabSnapshotFingerprint(ps, prevContent)
	}
	if prevHas && fpNew == fpPrev {
		if err := tx.Commit(ctx); err != nil {
			slog.Error("postCrontabSnapshot commit", "err", err)
			c.JSON(500, gin.H{"error": "failed to commit transaction"})
			return
		}
		c.JSON(200, gin.H{"ok": true, "changed": false, "snapshot_id": prevID.String()})
		return
	}

	var diffText string
	if prevHas {
		ps := ""
		if prevErr.Valid {
			ps = prevErr.String
		}
		diffText = strings.TrimSpace(buildCrontabDiffSummary(ps, prevContent, capErr, content))
	}

	newID := uuid.New()
	userCtx := strings.TrimSpace(p.UserContext)
	var capPtr any
	if capErr != "" {
		capPtr = capErr
	}
	var diffPtr any
	if diffText != "" {
		diffPtr = diffText
	}
	_, err = tx.Exec(ctx,
		`insert into crontab_snapshots(id,monitored_server_id,content_hash,content,user_context,capture_error,diff_from_previous) values($1,$2,$3,$4,$5,$6,$7)`,
		newID, srvID, hexHash, content, userCtx, capPtr, diffPtr,
	)
	if err != nil {
		slog.Error("postCrontabSnapshot insert", "err", err)
		c.JSON(500, gin.H{"error": "failed to store snapshot"})
		return
	}
	if err := tx.Commit(ctx); err != nil {
		slog.Error("postCrontabSnapshot commit", "err", err)
		c.JSON(500, gin.H{"error": "failed to commit transaction"})
		return
	}

	if prevHas && fpNew != fpPrev {
		if ns, nerr := notify.Load(ctx, a.db); nerr == nil && notify.ShouldNotifyCrontabChanged(ns) && notify.TransportAvailable(ctx, a.db, ns) {
			sub, body := notify.FormatCrontabChanged(sname, userCtx, diffText)
			disp := a.dispatcher()
			ts := time.Now().UTC().Format(time.RFC3339Nano)
			payload := notify.AlertPayload{
				AlertType:    notify.AlertTypeCrontabChanged,
				JobName:      sname,
				Status:       "changed",
				ErrorMessage: strings.TrimSpace(diffText),
				Timestamp:    ts,
				ServerHint:   userCtx,
			}
			if len(payload.ErrorMessage) > 800 {
				payload.ErrorMessage = payload.ErrorMessage[:800] + "…"
			}
			sum := disp.Dispatch(ctx, ns, uuid.Nil, nil, notify.AlertTypeCrontabChanged, sname, payload, sub, body, true, notify.DeliverableSMTP(ns))
			if !sum.AnySuccess {
				slog.Error("postCrontabSnapshot notify", "server", sname)
			}
		} else if nerr != nil {
			slog.Error("postCrontabSnapshot load notify", "err", nerr)
		}
	}

	c.JSON(200, gin.H{"ok": true, "changed": true, "snapshot_id": newID.String()})
}

func (a *app) listCrontabSnapshots(c *gin.Context) {
	sid := strings.TrimSpace(c.Query("server_id"))
	if _, err := uuid.Parse(sid); err != nil {
		c.JSON(400, gin.H{"error": "invalid server_id"})
		return
	}
	rows, err := a.db.Query(c.Request.Context(), `
select id, created_at, content_hash, user_context, capture_error, diff_from_previous
from crontab_snapshots where monitored_server_id=$1 order by created_at desc limit 50`,
		sid,
	)
	if err != nil {
		slog.Error("listCrontabSnapshots query", "err", err)
		c.JSON(500, gin.H{"error": "failed to list snapshots"})
		return
	}
	defer rows.Close()
	out := make([]gin.H, 0)
	for rows.Next() {
		var id uuid.UUID
		var created time.Time
		var hash, userCtx string
		var capErr, diff sql.NullString
		if err := rows.Scan(&id, &created, &hash, &userCtx, &capErr, &diff); err != nil {
			slog.Error("listCrontabSnapshots scan", "err", err)
			c.JSON(500, gin.H{"error": "failed to read snapshot row"})
			return
		}
		item := gin.H{
			"id":            id.String(),
			"created_at":    created.UTC().Format(time.RFC3339Nano),
			"content_hash":  hash,
			"user_context":  userCtx,
			"capture_error": nil,
			"diff_from_previous": nil,
		}
		if capErr.Valid {
			item["capture_error"] = capErr.String
		}
		if diff.Valid {
			item["diff_from_previous"] = diff.String
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		slog.Error("listCrontabSnapshots rows", "err", err)
		c.JSON(500, gin.H{"error": "failed to list snapshots"})
		return
	}
	c.JSON(200, out)
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

func (a *app) serverWatchLoop(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			a.evaluateServerHeartbeats(context.Background())
		}
	}
}

func (a *app) runTimeoutWatchLoop(ctx context.Context) {
	ticker := time.NewTicker(45 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			a.evaluateRunTimeouts(context.Background())
		}
	}
}

// evaluateRunTimeouts closes job_runs stuck in running past the job's timeout_seconds (crash recovery).
// When timeout_remote_kill_enabled is true, sets kill_requested_at first; after remoteKillGrace, marks timed_out.
func (a *app) evaluateRunTimeouts(ctx context.Context) {
	rows, err := a.db.Query(ctx, `
		select r.id, r.started_at, j.timeout_seconds, coalesce(j.timeout_remote_kill_enabled, false), r.kill_requested_at
		from job_runs r
		inner join cron_jobs j on j.id = r.job_id
		where lower(r.status) = 'running'
		  and r.ended_at is null
		  and j.timeout_seconds > 0
		  and r.started_at + (j.timeout_seconds * interval '1 second') < now()`)
	if err != nil {
		slog.Error("evaluateRunTimeouts query", "err", err)
		return
	}
	defer rows.Close()

	for rows.Next() {
		var id uuid.UUID
		var startedAt time.Time
		var timeoutSec int
		var remoteKill bool
		var killReq sql.NullTime
		if err := rows.Scan(&id, &startedAt, &timeoutSec, &remoteKill, &killReq); err != nil {
			slog.Error("evaluateRunTimeouts scan", "err", err)
			return
		}
		if remoteKill && !killReq.Valid {
			tag, err := a.db.Exec(ctx,
				`update job_runs set kill_requested_at=now() where id=$1 and kill_requested_at is null and lower(status)='running' and ended_at is null`,
				id,
			)
			if err != nil {
				slog.Error("evaluateRunTimeouts kill request", "run_id", id, "err", err)
				continue
			}
			if tag.RowsAffected() > 0 {
				continue
			}
		}
		if remoteKill && killReq.Valid {
			if time.Since(killReq.Time) < remoteKillGrace {
				continue
			}
		}
		ended := time.Now()
		durationMs := int(ended.Sub(startedAt) / time.Millisecond)
		reason := fmt.Sprintf("Run exceeded configured timeout of %d seconds (duration at timeout: %d ms)", timeoutSec, durationMs)
		fix := "Increase timeout_seconds, optimize the job, or set timeout to 0 to disable the limit."
		tag, err := a.db.Exec(ctx,
			`update job_runs set status='timed_out', ended_at=$2, duration_ms=$3, exit_code=null, failure_reason=$4, failure_fix=$5
			 where id=$1 and lower(status)='running' and ended_at is null`,
			id, ended, durationMs, reason, fix,
		)
		if err != nil {
			slog.Error("evaluateRunTimeouts update", "run_id", id, "err", err)
			continue
		}
		if tag.RowsAffected() == 0 {
			continue
		}
		ev, _ := json.Marshal(gin.H{"status": "timed_out", "failure_reason": reason})
		a.publish(id.String(), string(ev))
		a.notifyRunCompletedBackground(id)
	}
	if err := rows.Err(); err != nil {
		slog.Error("evaluateRunTimeouts rows", "err", err)
	}
}

func (a *app) evaluateHeartbeats(ctx context.Context) {
	ns, err := notify.Load(ctx, a.db)
	if err != nil {
		slog.Error("evaluateHeartbeats load notify", "err", err)
		return
	}
	if !notify.ShouldNotifyHeartbeatMissed(ns) || !notify.TransportAvailable(ctx, a.db, ns) {
		return
	}

	rows, err := a.db.Query(ctx,
		`select id, name, schedule, timezone, heartbeat_grace_seconds, created_at, last_heartbeat_at, last_heartbeat_alert_at from cron_jobs where coalesce(enabled, true) = true`,
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
		var lastAlertPtr *time.Time
		if alertN.Valid {
			t := alertN.Time
			lastAlertPtr = &t
		}
		if heartbeat.AbsenceAlertAlreadySentForWindow(lastAlertPtr, st.PrevFire) {
			continue
		}
		prevFireUTC := st.PrevFire.UTC()
		lastPing := ""
		if lastHB != nil {
			lastPing = lastHB.UTC().Format(time.RFC3339Nano)
		}
		minutesLate := int(now.Sub(st.PrevFire) / time.Minute)
		if minutesLate < 0 {
			minutesLate = 0
		}
		alertRowID := uuid.New()
		insTag, insErr := a.db.Exec(ctx,
			`insert into absence_alerts(id, job_id, scheduled_fire_at, minutes_late, job_name_snapshot, notification_sent) values($1,$2,$3,$4,$5,false)
			 on conflict (job_id, scheduled_fire_at) do nothing`,
			alertRowID, id, prevFireUTC, minutesLate, name,
		)
		if insErr != nil {
			slog.Error("evaluateHeartbeats absence_alerts insert", "job", name, "err", insErr)
			continue
		}
		if insTag.RowsAffected() == 0 {
			continue
		}
		subject, body := notify.FormatHeartbeatMissed(
			name,
			st.Status,
			prevFireUTC.Format(time.RFC3339Nano),
			st.Deadline.UTC().Format(time.RFC3339Nano),
			minutesLate,
			lastPing,
		)
		disp := a.dispatcher()
		ts := time.Now().UTC().Format(time.RFC3339Nano)
		payload := notify.AlertPayload{
			AlertType:    notify.AlertTypeHeartbeatMissed,
			JobName:      name,
			Status:       st.Status,
			ErrorMessage: fmt.Sprintf("Minutes late (since scheduled run): %d", minutesLate),
			Timestamp:    ts,
			JobURL:       disp.JobDeepLink(id),
			RunURL:       disp.RunDeepLink(id),
		}
		sum := disp.Dispatch(ctx, ns, id, nil, notify.AlertTypeHeartbeatMissed, "", payload, subject, body, false, notify.DeliverableSMTP(ns))
		if !sum.AnySuccess {
			if _, delErr := a.db.Exec(ctx, `delete from absence_alerts where id=$1`, alertRowID); delErr != nil {
				slog.Error("evaluateHeartbeats rollback absence_alerts", "job", name, "err", delErr)
			}
			slog.Error("evaluateHeartbeats dispatch failed", "job", name)
			continue
		}
		if _, err := a.db.Exec(ctx, `update absence_alerts set notification_sent=true where id=$1`, alertRowID); err != nil {
			slog.Error("evaluateHeartbeats absence_alerts mark sent", "job", name, "err", err)
		}
		if _, err := a.db.Exec(ctx, `update cron_jobs set last_heartbeat_alert_at=now() where id=$1`, id); err != nil {
			slog.Error("evaluateHeartbeats alert stamp", "err", err)
		}
	}
	if err := rows.Err(); err != nil {
		slog.Error("evaluateHeartbeats rows", "err", err)
	}
}

func (a *app) evaluateServerHeartbeats(ctx context.Context) {
	ns, err := notify.Load(ctx, a.db)
	if err != nil {
		slog.Error("evaluateServerHeartbeats load notify", "err", err)
		return
	}
	if !notify.ShouldNotifyServerUnreachable(ns) || !notify.TransportAvailable(ctx, a.db, ns) {
		return
	}
	rows, err := a.db.Query(ctx,
		`select id, name, created_at, last_seen_at from monitored_servers`,
	)
	if err != nil {
		slog.Error("evaluateServerHeartbeats query", "err", err)
		return
	}
	defer rows.Close()
	now := time.Now()
	for rows.Next() {
		var id uuid.UUID
		var name string
		var created time.Time
		var lastN sql.NullTime
		if err := rows.Scan(&id, &name, &created, &lastN); err != nil {
			slog.Error("evaluateServerHeartbeats scan", "err", err)
			return
		}
		var lastPtr *time.Time
		if lastN.Valid {
			t := lastN.Time
			lastPtr = &t
		}
		ref := serverUnreachableRef(created, lastPtr)
		if now.Sub(ref) < serverHeartbeatSilence {
			continue
		}
		silenceSec := int64(serverHeartbeatSilence / time.Second)
		claimTag, claimErr := a.db.Exec(ctx,
			`update monitored_servers set last_unreachable_alert_at=now()
			 where id=$1
			   and last_unreachable_alert_at is null
			   and coalesce(last_seen_at, created_at) <= $2::timestamptz - ($3::bigint * interval '1 second')`,
			id, now, silenceSec,
		)
		if claimErr != nil {
			slog.Error("evaluateServerHeartbeats claim", "server", name, "err", claimErr)
			continue
		}
		if claimTag.RowsAffected() == 0 {
			continue
		}
		lastSeenRFC := ""
		if lastPtr != nil {
			lastSeenRFC = lastPtr.UTC().Format(time.RFC3339Nano)
		}
		minutesSince := int(now.Sub(ref) / time.Minute)
		if minutesSince < 0 {
			minutesSince = 0
		}
		subject, body := notify.FormatServerUnreachable(name, lastSeenRFC, minutesSince)
		disp := a.dispatcher()
		ts := time.Now().UTC().Format(time.RFC3339Nano)
		payload := notify.AlertPayload{
			AlertType:    notify.AlertTypeServerUnreachable,
			JobName:      name,
			Status:       "unreachable",
			ErrorMessage: fmt.Sprintf("Minutes since last ping: %d", minutesSince),
			Timestamp:    ts,
			ServerHint:   name,
		}
		sum := disp.Dispatch(ctx, ns, uuid.Nil, nil, notify.AlertTypeServerUnreachable, name, payload, subject, body, true, notify.DeliverableSMTP(ns))
		if !sum.AnySuccess {
			if _, rerr := a.db.Exec(ctx, `update monitored_servers set last_unreachable_alert_at=null where id=$1`, id); rerr != nil {
				slog.Error("evaluateServerHeartbeats rollback stamp", "err", rerr)
			}
			slog.Error("evaluateServerHeartbeats dispatch failed", "server", name)
			continue
		}
	}
	if err := rows.Err(); err != nil {
		slog.Error("evaluateServerHeartbeats rows", "err", err)
	}
}

func (a *app) runDueJobs(ctx context.Context) error {
	rows, err := a.db.Query(ctx,
		"select id,name,schedule,timezone,working_dir,command,logging_enabled,timeout_seconds,coalesce(success_exit_code,0) from cron_jobs where coalesce(enabled, true) = true")
	if err != nil {
		return fmt.Errorf("query due jobs: %w", err)
	}
	defer rows.Close()

	now := time.Now()
	for rows.Next() {
		var id uuid.UUID
		var name, schedule, timezone, workingDir, command string
		var loggingEnabled bool
		var timeout, successExit int
		if err := rows.Scan(&id, &name, &schedule, &timezone, &workingDir, &command, &loggingEnabled, &timeout, &successExit); err != nil {
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

		startedAt := time.Now()
		if loggingEnabled {
			go func(id uuid.UUID, name, workingDir, command string, timeout, successExit int, startedAt time.Time) {
				if _, err := a.executeJob(context.Background(), id, name, workingDir, command, timeout, nil, "scheduled", successExit, startedAt); err != nil {
					slog.Error("scheduled job failed", "job", name, "err", err)
				}
			}(id, name, workingDir, command, timeout, successExit, startedAt)
		} else {
			if _, err := a.executeJob(context.Background(), id, name, workingDir, command, timeout, nil, "scheduled", successExit, startedAt); err != nil {
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
