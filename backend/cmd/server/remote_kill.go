package main

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// remoteKillGrace is how long the agent has after kill_requested_at before the server marks timed_out.
const remoteKillGrace = 90 * time.Second

func (a *app) getPendingKill(c *gin.Context) {
	idParam := strings.TrimSpace(c.Param("id"))
	jobUUID, err := uuid.Parse(idParam)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid job ID format"})
		return
	}
	tok := runsIngestAuthToken(c)
	if tok == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "missing ingest token: use Authorization: Bearer <token> or X-Runs-Ingest-Token"})
		return
	}
	var storedTok string
	err = a.db.QueryRow(c.Request.Context(), `select runs_ingest_token from cron_jobs where id=$1`, jobUUID).Scan(&storedTok)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "job not found"})
			return
		}
		slog.Error("getPendingKill lookup", "err", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to resolve job"})
		return
	}
	if storedTok != tok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid ingest token"})
		return
	}
	rows, err := a.db.Query(c.Request.Context(), `
		select id, kill_requested_at
		from job_runs
		where job_id=$1
		  and lower(status)='running'
		  and ended_at is null
		  and kill_requested_at is not null
		  and kill_ack_at is null
		order by kill_requested_at asc`,
		jobUUID,
	)
	if err != nil {
		slog.Error("getPendingKill query", "err", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list pending kills"})
		return
	}
	defer rows.Close()
	out := make([]gin.H, 0)
	for rows.Next() {
		var rid uuid.UUID
		var kr time.Time
		if err := rows.Scan(&rid, &kr); err != nil {
			slog.Error("getPendingKill scan", "err", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to read row"})
			return
		}
		out = append(out, gin.H{
			"run_id":              rid.String(),
			"signal":              "SIGTERM",
			"kill_requested_at":   kr.UTC().Format(time.RFC3339Nano),
		})
	}
	if err := rows.Err(); err != nil {
		slog.Error("getPendingKill rows", "err", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to iterate"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"runs": out})
}

func (a *app) postKillAck(c *gin.Context) {
	idParam := strings.TrimSpace(c.Param("id"))
	jobUUID, err := uuid.Parse(idParam)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid job ID format"})
		return
	}
	runIDStr := strings.TrimSpace(c.Param("runId"))
	runUUID, err := uuid.Parse(runIDStr)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid run ID format"})
		return
	}
	tok := runsIngestAuthToken(c)
	if tok == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "missing ingest token"})
		return
	}
	var storedTok string
	err = a.db.QueryRow(c.Request.Context(), `select runs_ingest_token from cron_jobs where id=$1`, jobUUID).Scan(&storedTok)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "job not found"})
			return
		}
		slog.Error("postKillAck job lookup", "err", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to resolve job"})
		return
	}
	if storedTok != tok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid ingest token"})
		return
	}
	tag, err := a.db.Exec(c.Request.Context(), `
		update job_runs set kill_ack_at=now()
		where id=$1 and job_id=$2 and kill_requested_at is not null and kill_ack_at is null
		  and lower(status)='running' and ended_at is null`,
		runUUID, jobUUID,
	)
	if err != nil {
		slog.Error("postKillAck update", "err", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to acknowledge"})
		return
	}
	if tag.RowsAffected() == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "run not found or not awaiting kill ack"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
