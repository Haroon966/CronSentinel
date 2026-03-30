-- FEAT-13: per-job encrypted environment variables (schema also applied in cmd/server ensureSchema).
CREATE TABLE IF NOT EXISTS job_env_vars (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
  name text NOT NULL,
  ciphertext bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, name)
);
CREATE INDEX IF NOT EXISTS job_env_vars_job_id_idx ON job_env_vars (job_id);
