-- FEAT-12: pause/monitor flag + config change audit trail
ALTER TABLE cron_jobs ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS job_config_audit (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
  changed_at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL DEFAULT '',
  changes jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS job_config_audit_job_changed_idx ON job_config_audit (job_id, changed_at DESC);
