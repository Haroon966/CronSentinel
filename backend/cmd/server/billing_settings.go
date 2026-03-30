package main

import (
	"errors"
	"log/slog"
	"net/http"

	"cronsentinel/internal/pricing"

	"github.com/gin-gonic/gin"
)

func (a *app) getBillingSettings(c *gin.Context) {
	if a.pricing == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "billing unavailable"})
		return
	}
	u, err := a.pricing.Snapshot(c.Request.Context())
	if err != nil {
		slog.Error("getBillingSettings snapshot", "err", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load billing usage"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"billing": u})
}

type patchBillingPayload struct {
	PlanSlug string `json:"plan_slug"`
}

func (a *app) patchBillingSettings(c *gin.Context) {
	if a.pricing == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "billing unavailable"})
		return
	}
	var p patchBillingPayload
	if err := c.BindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid JSON payload"})
		return
	}
	if err := a.pricing.SetPlanSlug(c.Request.Context(), p.PlanSlug); err != nil {
		switch {
		case errors.Is(err, pricing.ErrPlanLockedByEnv):
			c.JSON(http.StatusConflict, gin.H{"error": "Plan is controlled by CRONSENTINEL_PLAN; unset it to change plan in settings."})
			return
		case errors.Is(err, pricing.ErrUnknownPlanSlug) || errors.Is(err, pricing.ErrPlanSlugRequired):
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		default:
			slog.Error("patchBillingSettings", "err", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update plan"})
			return
		}
	}
	u, err := a.pricing.Snapshot(c.Request.Context())
	if err != nil {
		slog.Error("patchBillingSettings snapshot", "err", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "plan updated but failed to reload usage"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "billing": u})
}
