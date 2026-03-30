package main

import (
	"database/sql"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"cronsentinel/internal/heartbeat"
	"cronsentinel/internal/pricing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const v1JobSelect = `
select j.id,j.name,j.schedule,j.timezone,j.working_dir,j.command,j.comment,j.logging_enabled,j.timeout_seconds,coalesce(j.timeout_remote_kill_enabled,false),j.enabled,j.created_at,
	j.heartbeat_grace_seconds, j.last_heartbeat_at,
	coalesce(j.success_exit_code,0),
	coalesce(j.alert_use_default_channels,true),
	(select string_agg(channel_id::text, ',' order by channel_id) from job_alert_channels jm where jm.job_id = j.id),
	(case when j.heartbeat_token is not null and j.heartbeat_token <> '' then true else false end),
	lr.status, lr.started_at, lr.duration_ms
 from cron_jobs j
 left join lateral (
   select status, started_at, duration_ms
   from job_runs
   where job_id = j.id
   order by started_at desc
   limit 1
 ) lr on true`

func jobGinSanitized(
	now time.Time,
	id uuid.UUID, name, schedule, timezone, workingDir, cmd, comment string,
	logEnabled bool, timeout int, remoteKill bool, jobEnabled bool, created time.Time,
	grace int, lastN sql.NullTime,
	successExit int, useDefAlert bool, alertChCSV sql.NullString,
	hasHB bool,
	lrStatus sql.NullString, lrStarted sql.NullTime, lrDur sql.NullInt64,
) gin.H {
	var lastHB *time.Time
	if lastN.Valid {
		t := lastN.Time
		lastHB = &t
	}
	st := heartbeat.Classify(schedule, timezone, grace, created, lastHB, now)
	var lastAt any
	if lastHB != nil {
		lastAt = lastHB.UTC().Format(time.RFC3339Nano)
	} else {
		lastAt = nil
	}
	lastRunStatus := ""
	if lrStatus.Valid {
		lastRunStatus = lrStatus.String
	}
	dash := jobOverallStatus(hasHB, st.Status, lastRunStatus)
	if !jobEnabled {
		dash = "paused"
	}
	alertIDs := make([]string, 0)
	if alertChCSV.Valid && strings.TrimSpace(alertChCSV.String) != "" {
		for _, p := range strings.Split(alertChCSV.String, ",") {
			p = strings.TrimSpace(p)
			if p != "" {
				alertIDs = append(alertIDs, p)
			}
		}
	}
	row := gin.H{
		"id": id, "name": name, "schedule": schedule, "timezone": timezone, "working_directory": workingDir,
		"command": cmd, "comment": comment, "logging_enabled": logEnabled,
		"timeout_seconds": timeout, "timeout_remote_kill_enabled": remoteKill, "enabled": jobEnabled, "created_at": created.UTC().Format(time.RFC3339Nano),
		"heartbeat_grace_seconds":      grace,
		"last_heartbeat_at":            lastAt,
		"heartbeat_status":             st.Status,
		"heartbeat_deadline_at":        st.Deadline.UTC().Format(time.RFC3339Nano),
		"heartbeat_prev_fire_at":       st.PrevFire.UTC().Format(time.RFC3339Nano),
		"heartbeat_interval_seconds":   st.IntervalSeconds,
		"heartbeat_first_ping_due_by":  st.FirstPingDueBy.UTC().Format(time.RFC3339Nano),
		"success_exit_code":            successExit,
		"dashboard_status":             dash,
		"alert_use_default_channels":   useDefAlert,
		"alert_channel_ids":            alertIDs,
	}
	if lrStatus.Valid {
		row["last_run_status"] = lrStatus.String
	} else {
		row["last_run_status"] = nil
	}
	if lrStarted.Valid {
		row["last_run_at"] = lrStarted.Time.UTC().Format(time.RFC3339Nano)
	} else {
		row["last_run_at"] = nil
	}
	if lrDur.Valid {
		row["last_run_duration_ms"] = int(lrDur.Int64)
	} else {
		row["last_run_duration_ms"] = nil
	}
	return row
}

func (a *app) v1ScanJobRow(rows interface{ Scan(dest ...any) error }, now time.Time) (gin.H, error) {
	var id uuid.UUID
	var name, schedule, timezone, workingDir, cmd, comment string
	var logEnabled bool
	var timeout int
	var remoteKill bool
	var jobEnabled bool
	var created time.Time
	var grace, successExit int
	var lastN sql.NullTime
	var useDefAlert bool
	var alertChCSV sql.NullString
	var hasHB bool
	var lrStatus sql.NullString
	var lrStarted sql.NullTime
	var lrDur sql.NullInt64
	if err := rows.Scan(&id, &name, &schedule, &timezone, &workingDir, &cmd, &comment, &logEnabled, &timeout, &remoteKill, &jobEnabled, &created,
		&grace, &lastN, &successExit, &useDefAlert, &alertChCSV, &hasHB,
		&lrStatus, &lrStarted, &lrDur); err != nil {
		return nil, err
	}
	return jobGinSanitized(now, id, name, schedule, timezone, workingDir, cmd, comment, logEnabled, timeout, remoteKill, jobEnabled, created,
		grace, lastN, successExit, useDefAlert, alertChCSV, hasHB, lrStatus, lrStarted, lrDur), nil
}

func (a *app) v1FetchJobSanitized(c *gin.Context, jobID uuid.UUID) (gin.H, error) {
	now := time.Now()
	row := a.db.QueryRow(c.Request.Context(), v1JobSelect+` where j.id=$1`, jobID)
	h, err := a.v1ScanJobRow(row, now)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, pgx.ErrNoRows
		}
		return nil, err
	}
	return h, nil
}

func v1ErrCodeFromHTTP(status int) string {
	switch status {
	case http.StatusNotFound:
		return "not_found"
	case http.StatusInternalServerError:
		return "server_error"
	default:
		return "bad_request"
	}
}

func (a *app) v1GetJob(c *gin.Context) {
	jobUUID, err := uuid.Parse(strings.TrimSpace(c.Param("id")))
	if err != nil {
		writeV1Error(c, http.StatusBadRequest, "invalid_id", "invalid job ID format", nil)
		return
	}
	h, err := a.v1FetchJobSanitized(c, jobUUID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeV1Error(c, http.StatusNotFound, "not_found", "job not found", nil)
			return
		}
		slog.Error("v1GetJob", "err", err)
		writeV1Error(c, http.StatusInternalServerError, "server_error", "failed to load job", nil)
		return
	}
	writeV1JSON(c, http.StatusOK, gin.H{"job": h}, nil)
}

func (a *app) v1CreateJob(c *gin.Context) {
	var p jobPayload
	if err := c.BindJSON(&p); err != nil {
		writeV1Error(c, http.StatusBadRequest, "invalid_json", "invalid JSON payload", nil)
		return
	}
	timezone, workingDir, grace, successExit, errMsg := normalizeJobPayload(&p)
	if errMsg != "" {
		writeV1Error(c, http.StatusBadRequest, "validation_error", errMsg, nil)
		return
	}
	if a.pricing != nil {
		if err := a.pricing.CheckCreateMonitor(c.Request.Context()); err != nil {
			if errors.Is(err, pricing.ErrMonitorLimit) {
				writeV1Error(c, http.StatusConflict, "plan_limit_exceeded", "Monitor limit reached for your current plan. Delete a job or upgrade.", nil)
				return
			}
			slog.Error("v1CreateJob billing check", "err", err)
			writeV1Error(c, http.StatusInternalServerError, "server_error", "failed to verify plan limits", nil)
			return
		}
	}
	hbTok, err := heartbeat.GenerateToken()
	if err != nil {
		slog.Error("v1CreateJob heartbeat token", "err", err)
		writeV1Error(c, http.StatusInternalServerError, "server_error", "failed to create job", nil)
		return
	}
	ingestTok, err := heartbeat.GenerateToken()
	if err != nil {
		slog.Error("v1CreateJob runs ingest token", "err", err)
		writeV1Error(c, http.StatusInternalServerError, "server_error", "failed to create job", nil)
		return
	}
	jobID := uuid.New()
	en := jobPayloadEnabled(&p)
	_, err = a.db.Exec(c.Request.Context(),
		`insert into cron_jobs(id,name,schedule,timezone,working_dir,command,comment,logging_enabled,timeout_seconds,heartbeat_token,heartbeat_grace_seconds,runs_ingest_token,success_exit_code,enabled,timeout_remote_kill_enabled)
		 values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
		jobID, p.Name, p.Schedule, timezone, workingDir, p.Command, p.Comment, p.LoggingEnabled, p.TimeoutSeconds, hbTok, grace, ingestTok, successExit, en, p.TimeoutRemoteKillEnabled,
	)
	if err != nil {
		slog.Error("v1CreateJob db insert", "err", err)
		writeV1Error(c, http.StatusInternalServerError, "server_error", "failed to create job", nil)
		return
	}
	h, err := a.v1FetchJobSanitized(c, jobID)
	if err != nil {
		slog.Error("v1CreateJob fetch", "err", err)
		writeV1Error(c, http.StatusInternalServerError, "server_error", "failed to load created job", nil)
		return
	}
	writeV1JSON(c, http.StatusCreated, gin.H{"job": h}, nil)
}

func (a *app) v1UpdateJob(c *gin.Context) {
	id := strings.TrimSpace(c.Param("id"))
	jobUUID, err := uuid.Parse(id)
	if err != nil {
		writeV1Error(c, http.StatusBadRequest, "invalid_id", "invalid job ID format", nil)
		return
	}
	var p jobPayload
	if err := c.BindJSON(&p); err != nil {
		writeV1Error(c, http.StatusBadRequest, "invalid_json", "invalid JSON payload", nil)
		return
	}
	timezone, workingDir, grace, successExit, errMsg := normalizeJobPayload(&p)
	if errMsg != "" {
		writeV1Error(c, http.StatusBadRequest, "validation_error", errMsg, nil)
		return
	}
	enNew := jobPayloadEnabled(&p)
	if jerr := a.applyJobUpdate(c.Request.Context(), id, jobUUID, &p, timezone, workingDir, grace, successExit, enNew); jerr != nil {
		writeV1Error(c, jerr.Status, v1ErrCodeFromHTTP(jerr.Status), jerr.Message, nil)
		return
	}
	h, err := a.v1FetchJobSanitized(c, jobUUID)
	if err != nil {
		slog.Error("v1UpdateJob fetch", "err", err)
		writeV1Error(c, http.StatusInternalServerError, "server_error", "failed to load job", nil)
		return
	}
	writeV1JSON(c, http.StatusOK, gin.H{"job": h}, nil)
}

func (a *app) v1DeleteJob(c *gin.Context) {
	id := strings.TrimSpace(c.Param("id"))
	jobUUID, err := uuid.Parse(id)
	if err != nil {
		writeV1Error(c, http.StatusBadRequest, "invalid_id", "invalid job ID format", nil)
		return
	}
	tag, err := a.db.Exec(c.Request.Context(), "delete from cron_jobs where id=$1", id)
	if err != nil {
		slog.Error("v1DeleteJob db", "id", id, "err", err)
		writeV1Error(c, http.StatusInternalServerError, "server_error", "failed to delete job", nil)
		return
	}
	if tag.RowsAffected() == 0 {
		writeV1Error(c, http.StatusNotFound, "not_found", "job not found", nil)
		return
	}
	writeV1JSON(c, http.StatusOK, gin.H{"deleted": true, "id": jobUUID.String()}, nil)
}

func (a *app) v1GetHeartbeatToken(c *gin.Context) {
	jobUUID, err := uuid.Parse(strings.TrimSpace(c.Param("id")))
	if err != nil {
		writeV1Error(c, http.StatusBadRequest, "invalid_id", "invalid job ID format", nil)
		return
	}
	var tok string
	err = a.db.QueryRow(c.Request.Context(), `select heartbeat_token from cron_jobs where id=$1`, jobUUID).Scan(&tok)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeV1Error(c, http.StatusNotFound, "not_found", "job not found", nil)
			return
		}
		slog.Error("v1GetHeartbeatToken", "err", err)
		writeV1Error(c, http.StatusInternalServerError, "server_error", "failed to load job", nil)
		return
	}
	writeV1JSON(c, http.StatusOK, gin.H{"heartbeat_token": tok}, nil)
}

func (a *app) v1ListJobs(c *gin.Context) {
	limit := parseIntParam(c.Query("limit"), 50, 1, 500)
	cursorRaw := strings.TrimSpace(c.Query("cursor"))
	var cur *timeIDCursor
	if cursorRaw != "" {
		dec, err := decodeTimeIDCursor(cursorRaw)
		if err != nil {
			writeV1Error(c, http.StatusBadRequest, "invalid_cursor", err.Error(), nil)
			return
		}
		cur = &dec
	}

	where := ""
	args := make([]any, 0, 4)
	if cur != nil {
		where = " where (j.created_at, j.id) < ($1::timestamptz, $2::uuid)"
		args = append(args, cur.T, cur.ID)
	}
	argN := len(args) + 1
	args = append(args, limit+1)

	q := v1JobSelect + where + " order by j.created_at desc, j.id desc limit $" + strconv.Itoa(argN)
	rows, err := a.db.Query(c.Request.Context(), q, args...)
	if err != nil {
		slog.Error("v1ListJobs query", "err", err)
		writeV1Error(c, http.StatusInternalServerError, "server_error", "failed to query jobs", nil)
		return
	}
	defer rows.Close()

	now := time.Now()
	out := make([]gin.H, 0)
	var pageEndCreated time.Time
	var pageEndID uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		var name, schedule, timezone, workingDir, cmd, comment string
		var logEnabled bool
		var timeout int
		var jobEnabled bool
		var created time.Time
		var grace, successExit int
		var lastN sql.NullTime
		var useDefAlert bool
		var alertChCSV sql.NullString
		var hasHB bool
		var lrStatus sql.NullString
		var lrStarted sql.NullTime
		var lrDur sql.NullInt64
		if err := rows.Scan(&id, &name, &schedule, &timezone, &workingDir, &cmd, &comment, &logEnabled, &timeout, &jobEnabled, &created,
			&grace, &lastN, &successExit, &useDefAlert, &alertChCSV, &hasHB,
			&lrStatus, &lrStarted, &lrDur); err != nil {
			slog.Error("v1ListJobs scan", "err", err)
			writeV1Error(c, http.StatusInternalServerError, "server_error", "failed to read job row", nil)
			return
		}
		h := jobGinSanitized(now, id, name, schedule, timezone, workingDir, cmd, comment, logEnabled, timeout, jobEnabled, created,
			grace, lastN, successExit, useDefAlert, alertChCSV, hasHB, lrStatus, lrStarted, lrDur)
		out = append(out, h)
		if len(out) == limit {
			pageEndCreated = created
			pageEndID = id
		}
	}
	if err := rows.Err(); err != nil {
		slog.Error("v1ListJobs rows", "err", err)
		writeV1Error(c, http.StatusInternalServerError, "server_error", "error iterating jobs", nil)
		return
	}

	hasMore := len(out) > limit
	if hasMore {
		out = out[:limit]
	}
	meta := gin.H{"limit": limit, "has_more": hasMore}
	if hasMore {
		meta["next_cursor"] = encodeTimeIDCursor(pageEndCreated, pageEndID)
	}
	writeV1JSON(c, http.StatusOK, gin.H{"jobs": out}, meta)
}
