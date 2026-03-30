-- Monitored hosts that POST /api/server-heartbeat/:token (separate from job heartbeats).
create table if not exists monitored_servers (
  id uuid primary key,
  name text not null,
  heartbeat_token text not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  last_unreachable_alert_at timestamptz
);
create unique index if not exists monitored_servers_heartbeat_token_key on monitored_servers (heartbeat_token);

alter table notification_settings add column if not exists notify_server_unreachable boolean not null default true;
