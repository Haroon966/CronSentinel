# CronSentinel deployment notes

## Required for production

- **PostgreSQL** — set `DATABASE_URL` for the backend (see `docker-compose.yml`).
- **`CRONSENTINEL_ENV_ENCRYPTION_KEY`** — 32-byte key (hex or base64). Do not rely on the dev-derived key in production.
- **`CRONSENTINEL_PUBLIC_BASE_URL`** — public origin of the UI (e.g. `https://cron.example.com`) so alert emails and webhooks contain correct deep links (`/jobs`, `/jobs/{id}/history`).
- **Notifications** — configure SMTP and/or alert channels; enable **Missed heartbeat** in notification settings if you rely on absence alerts.

## Multi-replica backends

You may run multiple backend instances behind a load balancer for API and ingest traffic. Background loops (`evaluateHeartbeats`, server reachability, crontab snapshot locking) use database-level idempotency so duplicate alerts are not sent when more than one replica runs the same tick.

## Single vs multi-process scheduler

In-process tickers drive scheduled job execution and evaluators. For predictable local scheduling, run one “primary” backend or accept that each replica may attempt work (local execution is best-effort per node). See the PRD note on optional queue workers for future hard separation.

## Pricing / plans

Optional: `CRONSENTINEL_PRICING_CONFIG` for tier JSON, `CRONSENTINEL_PLAN` to pin a plan slug from the environment.

## Frontend SPA routing

The UI uses path-based routes (`/dashboard`, `/jobs`, `/runs`, `/jobs/:jobId/history`). Configure the reverse proxy to serve `index.html` for all non-file routes (standard SPA fallback).
