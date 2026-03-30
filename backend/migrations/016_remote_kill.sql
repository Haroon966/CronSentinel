-- Optional agent-assisted SIGTERM before marking run timed_out (FEAT-08).
ALTER TABLE cron_jobs ADD COLUMN IF NOT EXISTS timeout_remote_kill_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS kill_requested_at timestamptz;
ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS kill_ack_at timestamptz;
