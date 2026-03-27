# CronSentinel

CronSentinel is a Docker-first platform to manage cron jobs, scripts, run logs, failure diagnostics, and machine health from a modern web UI.

## Features

- Cron job CRUD with comments and quick schedule presets.
- Script CRUD with persisted bash script files.
- Manual run trigger with dual execution modes:
  - `logging_enabled=true`: background run + live SSE updates.
  - `logging_enabled=false`: synchronous run with timeout.
- Run history with stdout/stderr/exit code/timestamps and failure hints.
- Live run stream endpoint for long-running executions.
- System metrics dashboard (uptime, CPU, memory, disk, network, GPU availability hint).
- Docker Compose setup for app + Postgres.

## Quick Start

1. Start all services:
   - `docker compose up --build`
2. Open the UI:
   - `http://localhost:5173`
3. Backend API:
   - `http://localhost:8080`

## Project Structure

- `backend`: Go API, scheduler, runner, SSE, diagnostics.
- `frontend`: React + TypeScript dashboard UI.
- `docs`: API and deployment docs.

## Notes

- This version intentionally has no in-app authentication.
- Go is built in Docker via `backend/Dockerfile`.
- Logs are retained in `job_runs`; cleanup loop prunes old runs (default 7 days).
# CronSentinel
# CronSentinel
