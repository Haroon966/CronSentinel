-- Absence-based alerting: audit trail when a missed-heartbeat notification is sent

create table if not exists absence_alerts (
  id uuid primary key default uuid_generate_v4(),
  job_id uuid not null references cron_jobs(id) on delete cascade,
  created_at timestamptz not null default now(),
  scheduled_fire_at timestamptz not null,
  minutes_late int not null,
  job_name_snapshot text not null default '',
  notification_sent boolean not null default false
);

create index if not exists absence_alerts_job_created_idx on absence_alerts (job_id, created_at desc);
