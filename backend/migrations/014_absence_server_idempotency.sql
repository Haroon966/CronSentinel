-- Deduplicate absence_alerts on (job_id, scheduled_fire_at) for multi-replica safety.
DELETE FROM absence_alerts a
USING absence_alerts b
WHERE a.job_id = b.job_id
  AND a.scheduled_fire_at = b.scheduled_fire_at
  AND a.id > b.id;

CREATE UNIQUE INDEX IF NOT EXISTS absence_alerts_job_scheduled_unique
  ON absence_alerts (job_id, scheduled_fire_at);
