-- Crontab snapshots per monitored server (agent POSTs periodically).
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

alter table monitored_servers add column if not exists crontab_poll_interval_seconds int not null default 300;

alter table notification_settings add column if not exists notify_crontab_changed boolean not null default true;
