package main

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

func (a *app) v1RunJobManual(c *gin.Context) {
	id := strings.TrimSpace(c.Param("id"))
	jobUUID, err := uuid.Parse(id)
	if err != nil {
		writeV1Error(c, http.StatusBadRequest, "invalid_id", "invalid job ID format", nil)
		return
	}
	var name, command, workingDir string
	var loggingEnabled bool
	var timeout, successExit int
	err = a.db.QueryRow(c.Request.Context(),
		"select name,working_dir,command,logging_enabled,timeout_seconds,coalesce(success_exit_code,0) from cron_jobs where id=$1", id,
	).Scan(&name, &workingDir, &command, &loggingEnabled, &timeout, &successExit)
	if err != nil {
		writeV1Error(c, http.StatusNotFound, "not_found", "job not found", nil)
		return
	}
	if loggingEnabled {
		runID := uuid.New()
		startedRun := time.Now()
		if _, err := a.db.Exec(c.Request.Context(),
			"insert into job_runs(id,job_id,job_name,command,status,started_at,run_trigger) values($1,$2,$3,$4,'running',$5,$6)",
			runID, jobUUID, name, command, startedRun, "manual",
		); err != nil {
			slog.Error("v1RunJobManual insert run record", "job", name, "err", err)
			writeV1Error(c, http.StatusInternalServerError, "server_error", "failed to start job", nil)
			return
		}
		go func() {
			if _, err := a.executeJob(context.Background(), jobUUID, name, workingDir, command, timeout, &runID, "manual", successExit, startedRun); err != nil {
				slog.Error("background job execution failed", "job", name, "err", err)
			}
		}()
		writeV1JSON(c, http.StatusAccepted, gin.H{"status": "started_in_background", "run_id": runID.String()}, nil)
		return
	}
	runID, err := a.executeJob(c.Request.Context(), jobUUID, name, workingDir, command, timeout, nil, "manual", successExit, time.Now())
	if err != nil {
		slog.Error("manual job execution failed", "job", name, "err", err)
		writeV1Error(c, http.StatusInternalServerError, "server_error", "job execution failed: "+err.Error(), nil)
		return
	}
	writeV1JSON(c, http.StatusOK, gin.H{"run_id": runID.String()}, nil)
}
