<div align="center">

<!-- Animated waving banner via capsule-render -->
<img src="https://capsule-render.vercel.app/api?type=waving&color=0:0d0d2e,40:2d1060,70:1a3a6e,100:0d2a4e&height=230&section=header&text=CronSentinel&fontSize=72&fontColor=e2e8f0&animation=fadeIn&fontAlignY=38&desc=Self-hosted%20cron%20job%20manager%20%E2%80%A2%20real-time%20logs%20%E2%80%A2%20system%20monitoring&descAlignY=64&descSize=16&descColor=94a3b8" width="100%" alt="CronSentinel"/>

<!-- Badges -->
<p>
  <img src="https://img.shields.io/badge/license-CC%20BY--NC%204.0-a78bfa?style=for-the-badge&labelColor=0d0d1f" alt="License"/>
  <img src="https://img.shields.io/badge/Go-1.22+-38bdf8?style=for-the-badge&logo=go&logoColor=white&labelColor=0d0d1f" alt="Go"/>
  <img src="https://img.shields.io/badge/React-18-818cf8?style=for-the-badge&logo=react&logoColor=white&labelColor=0d0d1f" alt="React"/>
  <img src="https://img.shields.io/badge/PostgreSQL-16-6366f1?style=for-the-badge&logo=postgresql&logoColor=white&labelColor=0d0d1f" alt="PostgreSQL"/>
  <img src="https://img.shields.io/badge/Docker-ready-0ea5e9?style=for-the-badge&logo=docker&logoColor=white&labelColor=0d0d1f" alt="Docker"/>
</p>

<!-- Animated typing text -->
<img src="https://readme-typing-svg.demolab.com?font=Fira+Code&weight=600&size=16&duration=3000&pause=800&color=818CF8&center=true&vCenter=true&width=620&lines=Schedule+%E2%80%A2+Monitor+%E2%80%A2+Debug+your+cron+jobs;Real-time+log+streaming+via+SSE;Built+with+Go+%2B+React+%2B+PostgreSQL;Self-hosted+%26+completely+open+source" alt="Typing animation"/>

</div>

---

## ✨ What is CronSentinel?

> **CronSentinel** is a self-hosted cron job manager that gives you a beautiful web UI for everything cron — create schedules, watch output live, browse history, manage scripts, and monitor your server — all from one dashboard.

No cloud. No subscriptions. Runs entirely on your machine.

---

## 📸 Screenshots

| | |
|:---:|:---:|
| ![Dashboard](assets/Dashboard.png) | ![Cron jobs](assets/Cron-jobs.png) |
| ![Scripts](assets/scripts.png) | ![Run history](assets/Run-History.png) |
| ![Servers](assets/Servers.png) | ![Settings](assets/Settings.png) |

See the [screenshot gallery](docs/screenshots.md) for labeled views and captions.

---

## 🎬 Features at a Glance

<div align="center">

| | Feature | Description |
|:---:|:---|:---|
| 📅 | **Job Scheduler** | Create cron jobs with any valid cron expression |
| ▶️ | **Manual Trigger** | Run any job instantly, outside its schedule |
| 📡 | **Live Log Streaming** | Watch stdout/stderr as the job runs (Server-Sent Events) |
| 📜 | **Run History** | Browse every past execution with full logs |
| 🗂️ | **Script Library** | Store reusable shell scripts, reference them in jobs |
| 🖥️ | **System Monitor** | CPU, memory, disk, and load average in real time |
| 🕐 | **Human Schedules** | Type `every 5 minutes` instead of `*/5 * * * *` |
| ⚡ | **Preset Schedules** | One-click presets for common intervals |
| ⏱️ | **Timeout Protection** | Server-side timed-out runs + optional agent SIGTERM before final timeout |
| 🔍 | **Failure Analysis** | Each failed run shows cause and suggested fix |

</div>

---

## 🛠️ Tech Stack

<div align="center">

<img src="https://skillicons.dev/icons?i=go,react,ts,postgres,docker,vite&theme=dark" alt="Tech Stack Icons"/>

| Layer | Technology |
|:---:|:---|
| **Backend** | Go 1.22 · Gin · pgx · gopsutil |
| **Frontend** | React 18 · TypeScript · Vite · shadcn/ui · Tailwind |
| **Database** | PostgreSQL 16 |
| **Infra** | Docker · Docker Compose |
| **Realtime** | Server-Sent Events (SSE) |

</div>

---

## 🚀 Quick Start — Docker (Recommended)

> **Prerequisites:** [Docker](https://docs.docker.com/get-docker/) v24+ and [Docker Compose](https://docs.docker.com/compose/install/) v2.20+

```bash
# 1. Clone the repo
git clone https://github.com/your-username/cronsentinel.git
cd cronsentinel

# 2. Start everything (builds + runs all 3 services)
docker compose up --build
```

Wait for these lines in the output:

```
frontend-1  | Local:   http://localhost:5173/
backend-1   | server starting port=8080
```

Then open **http://localhost:5173** in your browser. Done. 🎉

<details>
<summary><b>⚙️ Useful Docker commands</b></summary>

```bash
# Run in background (detached mode)
docker compose up --build -d

# View logs
docker compose logs -f

# Stop all services
docker compose down

# Stop AND delete all data (wipes the database)
docker compose down -v

# Rebuild after code changes
docker compose up --build
```

</details>

---

## 🧰 Manual Installation (No Docker)

<details>
<summary><b>Click to expand manual setup instructions</b></summary>

### Requirements

- [Go](https://go.dev/dl/) 1.22+
- [Node.js](https://nodejs.org/) 18+
- [PostgreSQL](https://www.postgresql.org/download/) 14+

### Step 1 — Clone

```bash
git clone https://github.com/your-username/cronsentinel.git
cd cronsentinel
```

### Step 2 — Set up PostgreSQL

```sql
-- Run in psql as a superuser
CREATE USER postgres WITH PASSWORD 'postgres';
CREATE DATABASE cronsentinel OWNER postgres;
```

Or use any existing PostgreSQL instance — just update `DATABASE_URL` in step 3.

### Step 3 — Start the backend

```bash
cd backend
go mod download

PORT=8080 \
DATABASE_URL="postgres://postgres:postgres@localhost:5432/cronsentinel?sslmode=disable" \
SCRIPT_DIR="./scripts" \
go run ./cmd/server
```

The server creates all tables automatically on first start. You should see:

```
database ready attempt=1
server starting port=8080
```

### Step 4 — Start the frontend

Open a **new terminal**:

```bash
cd frontend
npm install
VITE_API_BASE_URL=http://localhost:8080 npm run dev
```

### Step 5 — Open the app

Visit **http://localhost:5173** 🎉

</details>

---

## 🧪 Frontend Dev Mode (Mock Backend)

Don't want to install Go or PostgreSQL? Use the built-in Node.js mock backend:

```bash
# Terminal 1 — mock API (no database needed)
node mock-backend.js

# Terminal 2 — frontend dev server
cd frontend && npm install && npm run dev
```

The mock runs on port `8080` and simulates API endpoints (including notification settings and run-history email stubs) with a local SQLite database.

---

## ⚙️ Environment Variables

<details>
<summary><b>Backend variables</b></summary>

| Variable | Default | Description |
|:---|:---|:---|
| `PORT` | `8080` | HTTP port |
| `DATABASE_URL` | `postgres://postgres:postgres@db:5432/cronsentinel?sslmode=disable` | PostgreSQL DSN |
| `SCRIPT_DIR` | `/data/scripts` | Where scripts are stored on disk |
| `NOTIFICATION_SMTP_PASSWORD` | _(empty)_ | If set, overrides the SMTP password stored in **Settings** (useful for Docker secrets without persisting the password in Postgres) |

</details>

<details>
<summary><b>Frontend variables</b></summary>

| Variable | Default | Description |
|:---|:---|:---|
| `VITE_API_BASE_URL` | `http://localhost:8080` | Backend API base URL. If you set this to an **empty** value by mistake, the browser will call `/api/...` on the Vite dev server and get **404** — either set a full URL or omit the variable. |
| `CRONSENTINEL_DEV_API_PROXY` | _(vite only)_ | Used by `vite.config.ts` to proxy `/api` and `/healthz`. In Docker dev, Compose sets this to `http://backend:8080` so the frontend container can reach the API. |

</details>

---

## 📖 Usage Guide

### Dashboard

Four tabs are available at all times:

| Tab | What it does |
|:---|:---|
| **Jobs** | Create, manage, and manually trigger cron jobs |
| **Scripts** | Write and store reusable shell scripts |
| **Runs** | Browse the full execution history; **Email history** sends up to 500 newest runs matching the current filters |
| **Settings** | Configure SMTP and when to email (scheduled vs manual, success vs failure) |

The header shows live system stats: **CPU cores · Memory · Disk · Load averages**.

### Email notifications

1. Open **Settings** and enable notifications.
2. Enter SMTP host, port, username (if required), **From**, and comma-separated **To** addresses. For port **587**, leave **STARTTLS** on; port **465** uses implicit TLS automatically.
3. Choose which events trigger mail (e.g. scheduled failure only, or all outcomes).
4. Use **Send test email** to verify delivery.
5. On **Run History**, use **Email history** to receive a plain-text summary of runs matching the current status filter and search (capped at 500 rows).

Until notifications are enabled and SMTP is valid, run alerts and history email are skipped.

---

### Creating a Job

1. Click **+ New Job** on the Jobs tab
2. Fill in the form:

| Field | Description |
|:---|:---|
| **Name** | Human-readable label |
| **Schedule** | Cron expression or plain English (e.g. `every hour`) |
| **Command** | Shell command to execute |
| **Working Directory** | Optional `cd` target before running |
| **Comment** | Notes about what this job does |
| **Timeout** | Max seconds before the job is killed |
| **Logging** | Toggle stdout/stderr capture |

3. Click **Create Job** — it will run automatically on schedule

#### 🕐 Cron Expression Reference

```
┌─────────── minute       (0–59)
│ ┌───────── hour         (0–23)
│ │ ┌─────── day of month (1–31)
│ │ │ ┌───── month        (1–12)
│ │ │ │ ┌─── day of week  (0–7, both 0 and 7 = Sunday)
│ │ │ │ │
* * * * *
```

<details>
<summary><b>Common cron examples</b></summary>

| Expression | Meaning |
|:---|:---|
| `* * * * *` | Every minute |
| `*/5 * * * *` | Every 5 minutes |
| `0 * * * *` | Every hour (on the hour) |
| `0 2 * * *` | Every day at 2:00 AM |
| `0 9 * * 1` | Every Monday at 9:00 AM |
| `0 0 1 * *` | First day of every month |
| `0 0 * * 0` | Every Sunday at midnight |
| `*/30 9-17 * * 1-5` | Every 30 min, 9am–5pm, weekdays only |

</details>

---

### Managing Scripts

Scripts are shell files stored in CronSentinel's script library. Reference them from job commands.

```
Scripts tab → + New Script → name it → write content → Save
```

Use a saved script in a job command:

```bash
bash /data/scripts/your-script-name.sh
```

> **Naming rules:** letters, numbers, `-`, `_`, `.` only — no spaces or slashes.

---

### Run History & Live Logs

Go to the **Runs** tab to see every execution. Status badges explained:

<div align="center">

| Badge | Meaning |
|:---:|:---|
| 🟢 `success` | Exited with code `0` |
| 🔴 `failed` | Exited with non-zero code |
| 🟡 `timeout` | Killed after exceeding the timeout |
| 🔵 `running` | Currently executing |

</div>

- Click any row to expand **full stdout/stderr** output
- Click **Stream live logs** on a running job to watch output in real time

---

## 🔌 API Reference

<details>
<summary><b>All REST endpoints</b></summary>

| Method | Endpoint | Description |
|:---:|:---|:---|
| `GET` | `/healthz` | Health check |
| `GET` | `/api/system` | Auto-detected system report (stable JSON): host/OS/kernel, CPU model and core counts, memory and swap, load, all visible filesystems, non-loopback network interfaces (counters), GPU when detectable (Linux DRM / optional `nvidia-smi`). Values reflect the process environment (e.g. container cgroup limits). |
| `GET` | `/api/scripts` | List all scripts |
| `POST` | `/api/scripts` | Create a script |
| `DELETE` | `/api/scripts/:name` | Delete a script |
| `GET` | `/api/jobs` | List all jobs |
| `GET` | `/api/jobs/presets` | List schedule presets |
| `POST` | `/api/jobs` | Create a job |
| `DELETE` | `/api/jobs/:id` | Delete a job |
| `POST` | `/api/jobs/:id/run` | Manually trigger a job |
| `GET` | `/api/runs` | List run history |
| `GET` | `/api/runs/:id/logs` | Get full logs for a run |
| `GET` | `/api/runs/:id/stream` | Stream live logs (SSE) |

</details>

---

## 📜 License

<div align="center">

This project is licensed under the **Creative Commons Attribution-NonCommercial 4.0 International** license.

| ✅ Allowed | ❌ Not Allowed |
|:---|:---|
| Use freely for personal or internal projects | Selling this software |
| Modify and adapt the code | Using it in a paid commercial product/service |
| Share and redistribute | Sublicensing under a different license |
| Build on top of it (non-commercial) | Removing attribution |

See the [LICENSE](./LICENSE) file for full legal text.

</div>

---

## 🤝 Contributing

Pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, guidelines, and the full workflow. For major changes, open an issue first to discuss what you would like to change.

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Commit your changes: `git commit -m 'Add amazing feature'`
4. Push to the branch: `git push origin feature/amazing-feature`
5. Open a Pull Request

Security-sensitive reports: [SECURITY.md](SECURITY.md).

---

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:0d2a4e,40:1a3a6e,70:2d1060,100:0d0d2e&height=120&section=footer" width="100%" alt="footer wave"/>

<div align="center">

<sub>Built with ❤️ · Free to use, free to modify · Just don't sell it</sub>

</div>
