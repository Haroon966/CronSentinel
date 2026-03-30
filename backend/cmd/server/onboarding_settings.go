package main

import (
	"database/sql"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
)

type onboardingDTO struct {
	CompletedAt *time.Time `json:"completed_at,omitempty"`
	Skipped     bool       `json:"skipped"`
}

func (a *app) getOnboardingSettings(c *gin.Context) {
	var completed sql.NullTime
	var skipped bool
	err := a.db.QueryRow(c.Request.Context(),
		`select onboarding_completed_at, coalesce(onboarding_skipped,false) from account_billing where id=1`,
	).Scan(&completed, &skipped)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			c.JSON(http.StatusOK, gin.H{"onboarding": onboardingDTO{}})
			return
		}
		slog.Error("getOnboardingSettings", "err", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load onboarding state"})
		return
	}
	out := onboardingDTO{Skipped: skipped}
	if completed.Valid {
		t := completed.Time.UTC()
		out.CompletedAt = &t
	}
	c.JSON(http.StatusOK, gin.H{"onboarding": out})
}

type patchOnboardingPayload struct {
	Completed *bool `json:"completed"`
	Skipped   *bool `json:"skipped"`
}

func (a *app) patchOnboardingSettings(c *gin.Context) {
	var p patchOnboardingPayload
	if err := c.BindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid JSON payload"})
		return
	}
	ctx := c.Request.Context()
	if p.Skipped != nil && *p.Skipped {
		if _, err := a.db.Exec(ctx,
			`update account_billing set onboarding_skipped=true, onboarding_completed_at=coalesce(onboarding_completed_at, now()), updated_at=now() where id=1`,
		); err != nil {
			slog.Error("patchOnboardingSettings skip", "err", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
		return
	}
	if p.Completed != nil && *p.Completed {
		if _, err := a.db.Exec(ctx,
			`update account_billing set onboarding_completed_at=now(), onboarding_skipped=false, updated_at=now() where id=1`,
		); err != nil {
			slog.Error("patchOnboardingSettings complete", "err", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
		return
	}
	c.JSON(http.StatusBadRequest, gin.H{"error": "expected completed or skipped"})
}
