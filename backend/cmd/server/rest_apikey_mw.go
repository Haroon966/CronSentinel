package main

import (
	"log/slog"
	"strings"
	"time"

	"cronsentinel/internal/apikey"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

const ginCtxAPIKeyID = "apiKeyID"

func (a *app) middlewareV1APIKey() gin.HandlerFunc {
	return func(c *gin.Context) {
		raw := strings.TrimSpace(strings.TrimPrefix(c.GetHeader("Authorization"), "Bearer "))
		if raw == "" {
			writeV1Error(c, 401, "unauthorized", "missing Authorization Bearer token", nil)
			c.Abort()
			return
		}
		if len(raw) < apikey.PrefixLen {
			writeV1Error(c, 401, "unauthorized", "invalid API key", nil)
			c.Abort()
			return
		}
		prefix := raw[:apikey.PrefixLen]
		var id uuid.UUID
		var hashStr string
		err := a.db.QueryRow(c.Request.Context(), `select id, key_hash from api_keys where key_prefix=$1 and revoked_at is null`, prefix).Scan(&id, &hashStr)
		if err != nil {
			writeV1Error(c, 401, "unauthorized", "invalid API key", nil)
			c.Abort()
			return
		}
		if err := apikey.Verify([]byte(hashStr), raw); err != nil {
			writeV1Error(c, 401, "unauthorized", "invalid API key", nil)
			c.Abort()
			return
		}
		c.Set(ginCtxAPIKeyID, id)
		c.Next()
	}
}

func (a *app) middlewareV1APIKeyRateLimit() gin.HandlerFunc {
	return func(c *gin.Context) {
		v, ok := c.Get(ginCtxAPIKeyID)
		if !ok {
			c.Next()
			return
		}
		id := v.(uuid.UUID)
		if !a.apiKeyHourly.Allow(id, time.Now()) {
			slog.Error("api key rate limited", "key_id", id)
			writeV1Error(c, 429, "rate_limited", "API key hourly request limit exceeded", nil)
			c.Abort()
			return
		}
		c.Next()
	}
}
