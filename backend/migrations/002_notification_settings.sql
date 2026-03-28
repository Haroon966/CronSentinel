-- Single-row notification / SMTP settings for CronSentinel
create table if not exists notification_settings (
  id int primary key check (id = 1),
  enabled boolean not null default false,
  smtp_host text not null default '',
  smtp_port int not null default 587,
  smtp_username text not null default '',
  smtp_password text not null default '',
  smtp_tls boolean not null default true,
  from_address text not null default '',
  to_addresses text not null default '',
  notify_scheduled_success boolean not null default false,
  notify_scheduled_failure boolean not null default false,
  notify_manual_success boolean not null default false,
  notify_manual_failure boolean not null default false
);

insert into notification_settings (id) values (1) on conflict (id) do nothing;
