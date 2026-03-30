-- FEAT-14: multi-channel alerts (Slack, generic webhook, Twilio SMS) + delivery log + per-job routing
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

-- channel_id references alert_channels(id) when not the SMTP sentinel (validated in app)
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
