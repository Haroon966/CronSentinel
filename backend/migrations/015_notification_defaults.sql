-- Enable missed-heartbeat alerts by default (FEAT-02); align existing singleton row with PRD expectations.
ALTER TABLE notification_settings
  ALTER COLUMN notify_heartbeat_missed SET DEFAULT true;

UPDATE notification_settings
SET notify_heartbeat_missed = true
WHERE id = 1;
