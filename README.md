# CronSentinel

A self-hosted cron job manager with a modern web UI. Create, schedule, and monitor cron jobs from your browser — with real-time log streaming, script management, and live system stats.

![License](https://img.shields.io/badge/license-CC%20BY--NC%204.0-blue)

---

## Features

- **Cron job management** — create, edit, delete, and manually trigger jobs
- **Script library** — write and store reusable shell scripts
- **Real-time log streaming** — watch job output live as it runs
- **Run history** — browse past runs with full stdout/stderr logs
- **System monitor** — CPU, memory, disk, and load average at a glance
- **Human-readable schedules** — enter cron syntax or plain English (`every 5 minutes`)
- **Preset schedules** — one-click presets for common intervals
- **Timeout support** — auto-kill long-running jobs after a configurable deadline

---

## Tech Stack

| Layer    | Technology                        |
|----------|-----------------------------------|
| Frontend | React + TypeScript + Vite + shadcn/ui |
| Backend  | Go (Gin framework)                |
| Database | PostgreSQL 16                     |
| Infra    | Docker + Docker Compose           |

---

## Requirements

### Docker setup (recommended)

- [Docker](https://docs.docker.com/get-docker/) v24+
- [Docker Compose](https://docs.docker.com/compose/install/) v2.20+

### Manual setup

- [Go](https://go.dev/dl/) 1.22+
- [Node.js](https://nodejs.org/) 18+
- [PostgreSQL](https://www.postgresql.org/download/) 14+

---

## Installation — Docker (Recommended)

This is the easiest way to run CronSentinel. Everything starts with a single command.

### 1. Clone the repository

```bash
git clone https://github.com/your-username/cronsentinel.git
cd cronsentinel
```

### 2. Start all services

```bash
docker compose up --build
```

This command:
- Builds the Go backend image
- Builds the React frontend image
- Starts a PostgreSQL database
- Wires everything together automatically

Wait for the output to show:

```
frontend-1  | Local:   http://localhost:5173/
backend-1   | server starting port=8080
```

### 3. Open the app

Visit **http://localhost:5173** in your browser.

### Stop the app

```bash
docker compose down
```

To also delete the database volume (wipes all data):

```bash
docker compose down -v
```

---

## Installation — Manual (No Docker)

Use this if you want to run each service directly on your machine.

### 1. Clone the repository

```bash
git clone https://github.com/your-username/cronsentinel.git
cd cronsentinel
```

### 2. Set up PostgreSQL

Create a database and user:

```sql
CREATE USER postgres WITH PASSWORD 'postgres';
CREATE DATABASE cronsentinel OWNER postgres;
```

Or use an existing PostgreSQL instance and update the connection string in the next step.

### 3. Start the backend

```bash
cd backend
go mod download
PORT=8080 \
DATABASE_URL="postgres://postgres:postgres@localhost:5432/cronsentinel?sslmode=disable" \
SCRIPT_DIR="./scripts" \
go run ./cmd/server
```

The backend creates all database tables automatically on first start.

### 4. Start the frontend

Open a new terminal:

```bash
cd frontend
npm install
VITE_API_BASE_URL=http://localhost:8080 npm run dev
```

### 5. Open the app

Visit **http://localhost:5173** in your browser.

---

## Environment Variables

### Backend

| Variable       | Default                                                      | Description                          |
|----------------|--------------------------------------------------------------|--------------------------------------|
| `PORT`         | `8080`                                                       | HTTP port the backend listens on     |
| `DATABASE_URL` | `postgres://postgres:postgres@db:5432/cronsentinel?sslmode=disable` | PostgreSQL connection string |
| `SCRIPT_DIR`   | `/data/scripts`                                              | Directory where scripts are stored   |

### Frontend

| Variable            | Default                  | Description                     |
|---------------------|--------------------------|---------------------------------|
| `VITE_API_BASE_URL` | `http://localhost:8080`  | URL of the backend API          |

---

## Usage Guide

### Dashboard overview

When you open CronSentinel you see three tabs:

| Tab       | What it does                                      |
|-----------|---------------------------------------------------|
| **Jobs**  | Manage scheduled cron jobs                        |
| **Scripts** | Write and store reusable shell scripts          |
| **Runs**  | Browse the history of all job executions          |

The top of the page shows live system stats: CPU count, memory usage, disk usage, and load averages.

---

### Creating a cron job

1. Click the **+ New Job** button on the Jobs tab.
2. Fill in the fields:

   | Field             | Description                                                         |
   |-------------------|---------------------------------------------------------------------|
   | **Name**          | A human-readable label for the job                                  |
   | **Schedule**      | Cron expression (e.g. `*/5 * * * *`) or pick a preset               |
   | **Command**       | Shell command to run (e.g. `bash /data/scripts/backup.sh`)          |
   | **Working Directory** | Optional directory to `cd` into before running the command      |
   | **Comment**       | Optional notes about what the job does                              |
   | **Timeout**       | Maximum seconds the job is allowed to run before it is killed        |
   | **Logging**       | Toggle to enable or disable storing stdout/stderr logs              |

3. Click **Create Job**.

The job will automatically run on schedule. You can also click the **Run now** (play) button to trigger it immediately.

#### Cron expression reference

```
┌─────────── minute       (0–59)
│ ┌───────── hour         (0–23)
│ │ ┌─────── day of month (1–31)
│ │ │ ┌───── month        (1–12)
│ │ │ │ ┌─── day of week  (0–7, 0 and 7 = Sunday)
│ │ │ │ │
* * * * *
```

Common examples:

| Expression      | Meaning                        |
|-----------------|--------------------------------|
| `* * * * *`     | Every minute                   |
| `*/5 * * * *`   | Every 5 minutes                |
| `0 * * * *`     | Every hour (at :00)            |
| `0 2 * * *`     | Every day at 2:00 AM           |
| `0 9 * * 1`     | Every Monday at 9:00 AM        |
| `0 0 1 * *`     | First day of every month       |
| `0 0 * * 0`     | Every Sunday at midnight       |

---

### Managing scripts

Scripts are shell scripts stored in CronSentinel's script library. You can reference them in job commands.

1. Go to the **Scripts** tab.
2. Click **+ New Script**.
3. Give it a name (letters, numbers, `-`, `_`, `.` only — no spaces).
4. Write your script content in the editor.
5. Click **Save**.

To use a saved script in a job, set the job command to:

```bash
bash /data/scripts/your-script-name.sh
```

To delete a script, click the trash icon next to it. Scripts that are referenced by active jobs should be removed from those jobs first.

---

### Viewing run history

1. Go to the **Runs** tab.
2. Each row shows the job name, status, start time, duration, and exit code.

Status badges:

| Badge      | Meaning                                      |
|------------|----------------------------------------------|
| `success`  | Job exited with code 0                       |
| `failed`   | Job exited with a non-zero code              |
| `timeout`  | Job was killed because it exceeded its timeout |
| `running`  | Job is currently executing                   |

3. Click any row to expand and see the full stdout/stderr output.
4. If a job is still **running**, click **Stream live logs** to watch output in real time.

---

### Running a job manually

On the **Jobs** tab, click the **play button** (▶) next to any job to run it immediately regardless of its schedule. The run will appear in the **Runs** tab straight away.

---

### Deleting a job

Click the **trash icon** next to a job. This deletes the job definition but keeps its run history in the Runs tab.

---

## Development — Mock Backend

If you only want to work on the frontend without running Go or PostgreSQL, use the included mock backend:

```bash
node mock-backend.js
```

Then start the frontend normally:

```bash
cd frontend
npm install
npm run dev
```

The mock backend runs on port 8080 and simulates all API endpoints with in-memory data.

---

## API Endpoints

| Method | Path                        | Description                        |
|--------|-----------------------------|------------------------------------|
| GET    | `/healthz`                  | Health check                       |
| GET    | `/api/system`               | System info (CPU, memory, disk)    |
| GET    | `/api/scripts`              | List all scripts                   |
| POST   | `/api/scripts`              | Create a script                    |
| DELETE | `/api/scripts/:name`        | Delete a script                    |
| GET    | `/api/jobs`                 | List all jobs                      |
| GET    | `/api/jobs/presets`         | List schedule presets              |
| POST   | `/api/jobs`                 | Create a job                       |
| DELETE | `/api/jobs/:id`             | Delete a job                       |
| POST   | `/api/jobs/:id/run`         | Manually trigger a job             |
| GET    | `/api/runs`                 | List run history                   |
| GET    | `/api/runs/:id/logs`        | Get logs for a run                 |
| GET    | `/api/runs/:id/stream`      | Stream live logs (SSE)             |

---

## License

This project is licensed under the **Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)** license.

You are free to **use**, **modify**, and **share** this project — but **you may not sell it** or use it as part of a commercial product or service.

See the [LICENSE](./LICENSE) file for full details.

---

## Contributing

Pull requests are welcome. For major changes, please open an issue first to discuss what you would like to change.
