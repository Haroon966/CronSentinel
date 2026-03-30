-- FEAT-08: distinguish notification policy for runs closed by timeout worker vs manual/scheduled.
alter table job_runs add column if not exists run_trigger text not null default 'scheduled';
