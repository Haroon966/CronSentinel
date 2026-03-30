package main

import (
	"database/sql"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"cronsentinel/internal/apikey"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type apiKeyCreatePayload struct {
	Name string `json:"name"`
}

func (a *app) listAPIKeysSettings(c *gin.Context) {
	rows, err := a.db.Query(c.Request.Context(),
		`select id, name, key_prefix, created_at, revoked_at from api_keys order by created_at desc`)
	if err != nil {
		slog.Error("listAPIKeysSettings query", "err", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list API keys"})
		return
	}
	defer rows.Close()
	items := make([]gin.H, 0)
	for rows.Next() {
		var id uuid.UUID
		var name, prefix string
		var created time.Time
		var revoked sql.NullTime
		if err := rows.Scan(&id, &name, &prefix, &created, &revoked); err != nil {
			slog.Error("listAPIKeysSettings scan", "err", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to read API key row"})
			return
		}
		row := gin.H{
			"id": id.String(), "name": name, "key_prefix": prefix,
			"created_at": created.UTC().Format(time.RFC3339Nano),
		}
		if revoked.Valid {
			row["revoked_at"] = revoked.Time.UTC().Format(time.RFC3339Nano)
		} else {
			row["revoked_at"] = nil
		}
		items = append(items, row)
	}
	if err := rows.Err(); err != nil {
		slog.Error("listAPIKeysSettings rows", "err", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list API keys"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": items})
}

func (a *app) createAPIKeySettings(c *gin.Context) {
	var p apiKeyCreatePayload
	if err := c.BindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid JSON payload"})
		return
	}
	name := strings.TrimSpace(p.Name)
	if name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name is required"})
		return
	}
	raw, err := apikey.GenerateRaw()
	if err != nil {
		slog.Error("createAPIKeySettings generate", "err", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create API key"})
		return
	}
	h, err := apikey.Hash(raw)
	if err != nil {
		slog.Error("createAPIKeySettings hash", "err", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create API key"})
		return
	}
	id := uuid.New()
	prefix := apikey.Prefix(raw)
	_, err = a.db.Exec(c.Request.Context(),
		`insert into api_keys(id, name, key_prefix, key_hash) values($1,$2,$3,$4)`,
		id, name, prefix, string(h),
	)
	if err != nil {
		slog.Error("createAPIKeySettings insert", "err", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save API key"})
		return
	}
	c.JSON(http.StatusCreated, gin.H{
		"id":         id.String(),
		"name":       name,
		"key":        raw,
		"key_prefix": prefix,
		"created_at": time.Now().UTC().Format(time.RFC3339Nano),
	})
}

func (a *app) revokeAPIKeySettings(c *gin.Context) {
	idStr := strings.TrimSpace(c.Param("id"))
	id, err := uuid.Parse(idStr)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid API key ID format"})
		return
	}
	tag, err := a.db.Exec(c.Request.Context(),
		`update api_keys set revoked_at = now(), updated_at = now() where id=$1 and revoked_at is null`, id)
	if err != nil {
		slog.Error("revokeAPIKeySettings", "err", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to revoke API key"})
		return
	}
	if tag.RowsAffected() == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "api key not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
