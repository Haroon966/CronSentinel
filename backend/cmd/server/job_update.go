package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"

	"cronsentinel/internal/notify"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// jobUpdateErr is a non-exceptional business error for job updates (HTTP status + message).
type jobUpdateErr struct {
	Status  int
	Message string
}

func (e *jobUpdateErr) Error() string { return e.Message }

// applyJobUpdate runs the same persistence as PUT /api/jobs/:id (audit + alert routing).
func (a *app) applyJobUpdate(ctx context.Context, id string, jobUUID uuid.UUID, p *jobPayload, timezone, workingDir string, grace, successExit int, enNew bool) *jobUpdateErr {
	var oldName, oldSched, oldTz, oldWD, oldCmd, oldComment string
	var oldLog bool
	var oldTimeout, oldGrace, oldSucc int
	var oldEn bool
	var oldRemoteKill bool
	qErr := a.db.QueryRow(ctx,
		`select name, schedule, timezone, working_dir, command, comment, logging_enabled, timeout_seconds, heartbeat_grace_seconds, coalesce(success_exit_code,0), coalesce(enabled,true), coalesce(timeout_remote_kill_enabled,false) from cron_jobs where id=$1`,
		jobUUID,
	).Scan(&oldName, &oldSched, &oldTz, &oldWD, &oldCmd, &oldComment, &oldLog, &oldTimeout, &oldGrace, &oldSucc, &oldEn, &oldRemoteKill)
	if qErr != nil {
		if errors.Is(qErr, pgx.ErrNoRows) {
			return &jobUpdateErr{Status: 404, Message: "job not found"}
		}
		slog.Error("applyJobUpdate load row", "id", id, "err", qErr)
		return &jobUpdateErr{Status: 500, Message: "failed to load job"}
	}

	diff := make(map[string]map[string]any)
	if oldName != p.Name {
		diff["name"] = map[string]any{"before": oldName, "after": p.Name}
	}
	if oldSched != p.Schedule {
		diff["schedule"] = map[string]any{"before": oldSched, "after": p.Schedule}
	}
	if oldTz != timezone {
		diff["timezone"] = map[string]any{"before": oldTz, "after": timezone}
	}
	if oldWD != workingDir {
		diff["working_directory"] = map[string]any{"before": oldWD, "after": workingDir}
	}
	if oldCmd != p.Command {
		diff["command"] = map[string]any{"before": oldCmd, "after": p.Command}
	}
	if oldComment != p.Comment {
		diff["comment"] = map[string]any{"before": oldComment, "after": p.Comment}
	}
	if oldLog != p.LoggingEnabled {
		diff["logging_enabled"] = map[string]any{"before": oldLog, "after": p.LoggingEnabled}
	}
	if oldTimeout != p.TimeoutSeconds {
		diff["timeout_seconds"] = map[string]any{"before": oldTimeout, "after": p.TimeoutSeconds}
	}
	if oldGrace != grace {
		diff["heartbeat_grace_seconds"] = map[string]any{"before": oldGrace, "after": grace}
	}
	if oldSucc != successExit {
		diff["success_exit_code"] = map[string]any{"before": oldSucc, "after": successExit}
	}
	if oldEn != enNew {
		diff["enabled"] = map[string]any{"before": oldEn, "after": enNew}
	}
	if oldRemoteKill != p.TimeoutRemoteKillEnabled {
		diff["timeout_remote_kill_enabled"] = map[string]any{"before": oldRemoteKill, "after": p.TimeoutRemoteKillEnabled}
	}

	tag, err := a.db.Exec(ctx,
		`update cron_jobs set name=$2,schedule=$3,timezone=$4,working_dir=$5,command=$6,comment=$7,logging_enabled=$8,timeout_seconds=$9,heartbeat_grace_seconds=$10,success_exit_code=$11,enabled=$12,timeout_remote_kill_enabled=$13 where id=$1`,
		jobUUID, p.Name, p.Schedule, timezone, workingDir, p.Command, p.Comment, p.LoggingEnabled, p.TimeoutSeconds, grace, successExit, enNew, p.TimeoutRemoteKillEnabled,
	)
	if err != nil {
		slog.Error("applyJobUpdate db update", "id", id, "err", err)
		return &jobUpdateErr{Status: 500, Message: "failed to update job"}
	}
	if tag.RowsAffected() == 0 {
		return &jobUpdateErr{Status: 404, Message: "job not found"}
	}
	if len(diff) > 0 {
		jb, jerr := json.Marshal(diff)
		if jerr != nil {
			slog.Error("applyJobUpdate audit marshal", "err", jerr)
		} else {
			if _, ae := a.db.Exec(ctx, `insert into job_config_audit(id, job_id, actor, changes) values($1,$2,$3,$4)`, uuid.New(), jobUUID, "", jb); ae != nil {
				slog.Error("applyJobUpdate audit insert", "id", id, "err", ae)
			}
		}
	}
	if p.AlertRouting != nil {
		useDef := p.AlertRouting.UseDefault
		var chs []uuid.UUID
		if !useDef {
			for _, sid := range p.AlertRouting.ChannelIDs {
				if u, perr := uuid.Parse(strings.TrimSpace(sid)); perr == nil {
					chs = append(chs, u)
				}
			}
		}
		if rerr := notify.ReplaceJobAlertRouting(ctx, a.db, jobUUID, useDef, chs); rerr != nil {
			slog.Error("applyJobUpdate alert routing", "id", id, "err", rerr)
			return &jobUpdateErr{Status: 500, Message: "failed to save alert channel routing"}
		}
	}
	return nil
}
