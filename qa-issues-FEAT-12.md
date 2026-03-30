# QA issues — FEAT-12 No-Redeploy Schedule Editor

Structured findings from [cursor-qa-agent.md](cursor-qa-agent.md) pass (2026-03-29). For the implementation agent to fix or accept as tech debt.

---

## Issue #1 — Missing automated tests for FEAT-12

**Severity:** MEDIUM  

**Location:** No `*_test.go` coverage for `updateJob`; no Vitest tests for `saveEditJob` / edit modal in [frontend/src/App.tsx](frontend/src/App.tsx).

**Description:** Acceptance criteria are implemented in code but there is no test that verifies PUT `/api/jobs/:id`, audit row insertion, optimistic rollback, or confirmation gating. Per QA rules, missing coverage for a criterion counts as a gap.

**Steps to reproduce:**

1. Search the repo for `updateJob` or `saveEditJob` in test files — no matches.

**Expected:** At least one integration test (Go) for successful update + audit diff JSON, and/or frontend tests for validation + retry action.

**Actual:** Only unrelated unit tests (e.g. cron helpers, onboarding storage).

---

## Issue #2 — Audit trail not visible in product

**Severity:** MEDIUM  

**Location:** [backend/cmd/server/main.go](backend/cmd/server/main.go) (`updateJob` inserts into `job_config_audit`); no `GET` handler for audit rows.

**Description:** PRD acceptance: “Change logged to job audit trail (who changed what, when).” Rows are written with `actor` `''` (per implementation note), but operators cannot see history without direct DB access. There is no API or UI to list changes.

**Steps to reproduce:**

1. Update a job via the dashboard.
2. Search routes for `job_config_audit` reads — only `INSERT` exists.

**Expected:** Either a documented operator workflow (e.g. SQL view) or a `GET /api/jobs/:id/audit` (and optional UI).

**Actual:** Persistence only.

---

## Issue #3 — Backend cron validation weaker than frontend

**Severity:** MEDIUM  

**Location:** [backend/cmd/server/main.go](backend/cmd/server/main.go) — `isLikelyCron` only checks `len(strings.Fields(s)) == 5`.

**Description:** Frontend [frontend/src/features/jobs/validators.ts](frontend/src/features/jobs/validators.ts) uses `isCronExpressionSchedulable` for semantic validation. Direct API calls can persist schedules that the UI would reject (e.g. invalid ranges/steps that still produce five tokens).

**Steps to reproduce:**

1. `PUT /api/jobs/:id` with body containing `"schedule": "99 99 99 99 99"` (five fields).
2. Observe 200 if other fields valid.

**Expected:** Align server validation with client rules or document API as “trusted client only.”

**Actual:** Server accepts any five-field string.

---

## Issue #4 — Response shape vs project standards

**Severity:** LOW  

**Location:** [backend/cmd/server/main.go](backend/cmd/server/main.go) `updateJob` — `c.JSON(200, gin.H{"ok": true})`.

**Description:** [cursor-agent.md](cursor-agent.md) calls for `{ data, error, meta }` on API responses. `updateJob` uses `{ ok: true }` and errors as `{ error: string }`. Frontend [frontend/src/lib/api.ts](frontend/src/lib/api.ts) already handles this pattern.

**Expected:** Document exception or migrate endpoint to standard envelope.

**Actual:** Inconsistent with stated global convention but functional for current client.

---

## Issue #5 — Go test suite not executed in QA environment

**Severity:** N/A (process)  

**Location:** Host environment.

**Description:** `go` was not available on the QA host and Docker socket was not accessible, so `go test ./...` could not be run here. This is an environment limitation, not necessarily a product defect.

**Recommendation:** Run `go test ./...` in CI or a dev container before release.

---

## Issue #6 — Live browser verification skipped

**Severity:** N/A (process)  

**Location:** MCP browser navigated to `http://localhost:5173` → connection error (`chrome-error://chromewebdata/`).

**Description:** End-to-end checks (console errors, responsive layout, Tab order) were assessed via code review only.

**Recommendation:** Re-run checklist against a running docker-compose stack locally.
