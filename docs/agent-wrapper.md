# Remote timeout kill (agent integration)

When a job has `timeout_remote_kill_enabled` and `timeout_seconds > 0`, the server first sets `kill_requested_at` on overdue runs instead of immediately marking `timed_out`. Your wrapper polls for pending kills and sends **SIGTERM** to the child process, then acknowledges.

## API (Bearer = job `runs_ingest_token`)

- `GET /api/jobs/{jobId}/runs/pending-kill`  
  Response: `{ "runs": [ { "run_id", "signal": "SIGTERM", "kill_requested_at" } ] }`

- `POST /api/jobs/{jobId}/runs/{runId}/kill-ack`  
  Call after signaling the process (or if already exited).

After ~90 seconds without the run completing, the timeout worker marks the run `timed_out` anyway.

## Example wrapper (bash)

```bash
#!/usr/bin/env bash
set -euo pipefail
JOB_ID="$1"
API_BASE="${CRONSENTINEL_API_BASE:-http://127.0.0.1:8080}"
TOKEN="${CRONSENTINEL_RUNS_INGEST_TOKEN:?set token}"
shift
CHILD_PID=""
poll_kill() {
  while kill -0 "$CHILD_PID" 2>/dev/null; do
    RUNS="$(curl -fsS -H "Authorization: Bearer $TOKEN" \
      "$API_BASE/api/jobs/$JOB_ID/runs/pending-kill" | jq -r '.runs[]?.run_id // empty')"
    for R in $RUNS; do
      kill -TERM "$CHILD_PID" 2>/dev/null || true
      curl -fsS -X POST -H "Authorization: Bearer $TOKEN" \
        "$API_BASE/api/jobs/$JOB_ID/runs/$R/kill-ack" -d '{}' >/dev/null
    done
    sleep 2
  done
}
"$@" &
CHILD_PID=$!
poll_kill
wait "$CHILD_PID"
```

Adapt `jq`/`curl` availability for your environment; use HTTPS and secrets management in production.
