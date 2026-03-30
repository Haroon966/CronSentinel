-- FEAT-16: predictable flat pricing — current plan + usage derived from cron_jobs + alert_delivery_log
create table if not exists account_billing (
  id smallint primary key check (id = 1),
  plan_slug text not null default 'free',
  updated_at timestamptz not null default now()
);

insert into account_billing (id, plan_slug) values (1, 'free')
  on conflict (id) do nothing;
