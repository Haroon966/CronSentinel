-- FEAT-15: REST API keys (Bearer auth for /api/v1)
create table if not exists api_keys (
  id uuid primary key,
  name text not null default '',
  key_prefix text not null,
  key_hash text not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists api_keys_key_prefix_key on api_keys (key_prefix);
create index if not exists api_keys_revoked_idx on api_keys (revoked_at);
