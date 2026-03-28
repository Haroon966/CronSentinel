-- Heartbeat monitoring: per-job token, grace, last ping, alert dedup; ping history; notification toggle

alter table cron_jobs add column if not exists heartbeat_token text;
alter table cron_jobs add column if not exists heartbeat_grace_seconds int not null default 300;
alter table cron_jobs add column if not exists last_heartbeat_at timestamptz;
alter table cron_jobs add column if not exists last_heartbeat_alert_at timestamptz;

update cron_jobs
set heartbeat_token = replace(uuid_generate_v4()::text, '-', '') || replace(uuid_generate_v4()::text, '-', '')
where heartbeat_token is null;

alter table cron_jobs alter column heartbeat_token set not null;

create unique index if not exists cron_jobs_heartbeat_token_key on cron_jobs (heartbeat_token);

create table if not exists heartbeat_pings (
  id uuid primary key default uuid_generate_v4(),
  job_id uuid not null references cron_jobs(id) on delete cascade,
  received_at timestamptz not null default now(),
  client_ip text not null default '',
  payload text not null default ''
);

create index if not exists heartbeat_pings_job_received_idx on heartbeat_pings (job_id, received_at desc);

alter table notification_settings add column if not exists notify_heartbeat_missed boolean not null default false;
