package main

import (
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (a *app) v1ListRuns(c *gin.Context) {
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

	fp, bad := parseRunsFilterParams(c)
	if bad != nil {
		e, _ := (*bad)["error"].(string)
		if e == "" {
			e = "invalid query parameters"
		}
		writeV1Error(c, http.StatusBadRequest, "validation_error", e, nil)
		return
	}

	where, args, argN, werr := buildRunsWhere(fp.Status, fp.Search, fp.JobID, fp.StartedAfter, fp.StartedBefore, fp.MinDurMs, fp.MaxDurMs)
	if werr != nil {
		writeV1Error(c, http.StatusBadRequest, "validation_error", "invalid job ID format", nil)
		return
	}
	if cur != nil {
		where = append(where, fmt.Sprintf("(started_at, id) < ($%d::timestamptz, $%d::uuid)", argN, argN+1))
		args = append(args, cur.T, cur.ID)
		argN += 2
	}

	whereSQL := ""
	if len(where) > 0 {
		whereSQL = " where " + strings.Join(where, " and ")
	}

	args = append(args, limit+1)
	listSQL := "select id,job_id,job_name,command,status,exit_code,started_at,ended_at,failure_reason,failure_fix,duration_ms,stdout_truncated,stderr_truncated," + logPreviewSQL160 + " as log_preview, run_trigger from job_runs" + whereSQL + " order by started_at desc, id desc limit $" + strconv.Itoa(argN)
	rows, err := a.db.Query(c.Request.Context(), listSQL, args...)
	if err != nil {
		slog.Error("v1ListRuns query", "err", err)
		writeV1Error(c, http.StatusInternalServerError, "server_error", "failed to query runs", nil)
		return
	}
	defer rows.Close()

	out := make([]gin.H, 0)
	var pageEndStarted time.Time
	var pageEndID uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		var jobID *uuid.UUID
		var name, command, status, reason, fix string
		var exitCode *int
		var started time.Time
		var ended *time.Time
		var dur sql.NullInt64
		var outTrunc, errTrunc bool
		var logPreview string
		var runTrigger string
		if err := rows.Scan(&id, &jobID, &name, &command, &status, &exitCode, &started, &ended, &reason, &fix, &dur, &outTrunc, &errTrunc, &logPreview, &runTrigger); err != nil {
			slog.Error("v1ListRuns scan", "err", err)
			writeV1Error(c, http.StatusInternalServerError, "server_error", "failed to read run row", nil)
			return
		}
		jidVal := any(nil)
		if jobID != nil {
			jidVal = jobID.String()
		}
		row := gin.H{
			"id": id.String(), "job_id": jidVal, "job_name": name, "command": command, "status": status,
			"exit_code": exitCode, "started_at": started.UTC().Format(time.RFC3339Nano), "run_trigger": runTrigger,
			"failure_reason": reason, "failure_fix": fix,
			"stdout_truncated": outTrunc, "stderr_truncated": errTrunc,
			"log_preview":      logPreview,
		}
		if ended != nil {
			row["ended_at"] = ended.UTC().Format(time.RFC3339Nano)
		} else {
			row["ended_at"] = nil
		}
		if dur.Valid {
			row["duration_ms"] = int(dur.Int64)
		}
		out = append(out, row)
		if len(out) == limit {
			pageEndStarted = started
			pageEndID = id
		}
	}
	if err := rows.Err(); err != nil {
		slog.Error("v1ListRuns rows", "err", err)
		writeV1Error(c, http.StatusInternalServerError, "server_error", "error iterating runs", nil)
		return
	}

	hasMore := len(out) > limit
	if hasMore {
		out = out[:limit]
	}
	meta := gin.H{"limit": limit, "has_more": hasMore}
	if hasMore {
		meta["next_cursor"] = encodeTimeIDCursor(pageEndStarted, pageEndID)
	}
	writeV1JSON(c, http.StatusOK, gin.H{"runs": out}, meta)
}

func (a *app) v1GetRun(c *gin.Context) {
	runUUID, err := uuid.Parse(strings.TrimSpace(c.Param("id")))
	if err != nil {
		writeV1Error(c, http.StatusBadRequest, "invalid_id", "invalid run ID format", nil)
		return
	}
	var jobID *uuid.UUID
	var name, command, status, reason, fix, stdout, stderr, runTrigger string
	var exitCode *int
	var started time.Time
	var ended *time.Time
	var dur sql.NullInt64
	var outTrunc, errTrunc bool
	err = a.db.QueryRow(c.Request.Context(),
		`select job_id, job_name, command, status, exit_code, started_at, ended_at, failure_reason, failure_fix, duration_ms, stdout, stderr, stdout_truncated, stderr_truncated, run_trigger
		 from job_runs where id=$1`, runUUID,
	).Scan(&jobID, &name, &command, &status, &exitCode, &started, &ended, &reason, &fix, &dur, &stdout, &stderr, &outTrunc, &errTrunc, &runTrigger)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeV1Error(c, http.StatusNotFound, "not_found", "run not found", nil)
			return
		}
		slog.Error("v1GetRun", "err", err)
		writeV1Error(c, http.StatusInternalServerError, "server_error", "failed to load run", nil)
		return
	}
	jidVal := any(nil)
	if jobID != nil {
		jidVal = jobID.String()
	}
	row := gin.H{
		"id": runUUID.String(), "job_id": jidVal, "job_name": name, "command": command, "status": status,
		"exit_code": exitCode, "started_at": started.UTC().Format(time.RFC3339Nano), "run_trigger": runTrigger,
		"failure_reason": reason, "failure_fix": fix,
		"stdout": stdout, "stderr": stderr,
		"stdout_truncated": outTrunc, "stderr_truncated": errTrunc,
	}
	if ended != nil {
		row["ended_at"] = ended.UTC().Format(time.RFC3339Nano)
	} else {
		row["ended_at"] = nil
	}
	if dur.Valid {
		row["duration_ms"] = int(dur.Int64)
	}
	writeV1JSON(c, http.StatusOK, gin.H{"run": row}, nil)
}
