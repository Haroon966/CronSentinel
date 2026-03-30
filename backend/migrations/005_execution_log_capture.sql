-- External run ingest, log truncation metadata, configurable success exit code

alter table cron_jobs add column if not exists success_exit_code int not null default 0;
alter table cron_jobs add column if not exists runs_ingest_token text;

update cron_jobs
set runs_ingest_token = replace(uuid_generate_v4()::text, '-', '') || replace(uuid_generate_v4()::text, '-', '')
where runs_ingest_token is null or runs_ingest_token = '';

alter table cron_jobs alter column runs_ingest_token set not null;

create unique index if not exists cron_jobs_runs_ingest_token_key on cron_jobs (runs_ingest_token);

alter table job_runs add column if not exists duration_ms int;
alter table job_runs add column if not exists stdout_truncated boolean not null default false;
alter table job_runs add column if not exists stderr_truncated boolean not null default false;
