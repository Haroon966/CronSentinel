# API Reference

Base URL: `http://localhost:8080`

## Health

- `GET /healthz`

## System

- `GET /api/system` - uptime, memory, load, disks, network, cpu count, gpu hint.

## Scripts

- `GET /api/scripts`
- `POST /api/scripts`
  - body:
    ```json
    { "name": "backup", "content": "echo backup started" }
    ```
- `DELETE /api/scripts/:name`

## Jobs

- `GET /api/jobs`
- `GET /api/jobs/presets`
- `POST /api/jobs`
  - body:
    ```json
    {
      "name": "nightly backup",
      "schedule": "0 0 * * *",
      "command": "bash /data/scripts/backup.sh",
      "comment": "main backup",
      "logging_enabled": true,
      "timeout_seconds": 300
    }
    ```
- `DELETE /api/jobs/:id`
- `POST /api/jobs/:id/run` - run immediately.

## Runs & Logs

- `GET /api/runs` - latest 100 runs.
- `GET /api/runs/:id/logs` - full stdout/stderr.
- `GET /api/runs/:id/stream` - Server-Sent Events stream.

SSE payload examples:

```json
{"status":"running","stream":"stdout","line":"step 1"}
```

```json
{"status":"success","stdout":"...","stderr":"","exit_code":0}
```
