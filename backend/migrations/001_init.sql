create extension if not exists "uuid-ossp";

create table if not exists scripts (
  id uuid primary key default uuid_generate_v4(),
  name text unique not null,
  content text not null,
  created_at timestamptz not null default now()
);

create table if not exists cron_jobs (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  schedule text not null,
  working_dir text not null default '',
  command text not null,
  comment text not null default '',
  logging_enabled boolean not null default true,
  timeout_seconds int not null default 300,
  created_at timestamptz not null default now()
);

create table if not exists job_runs (
  id uuid primary key default uuid_generate_v4(),
  job_id uuid references cron_jobs(id) on delete set null,
  job_name text not null,
  command text not null,
  status text not null,
  exit_code int,
  stdout text not null default '',
  stderr text not null default '',
  started_at timestamptz not null,
  ended_at timestamptz,
  failure_reason text not null default '',
  failure_fix text not null default ''
);
