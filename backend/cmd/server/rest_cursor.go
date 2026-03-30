package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

type timeIDCursor struct {
	T  time.Time `json:"t"`
	ID uuid.UUID `json:"id"`
}

func encodeTimeIDCursor(t time.Time, id uuid.UUID) string {
	raw, err := json.Marshal(timeIDCursor{T: t.UTC(), ID: id})
	if err != nil {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}

func decodeTimeIDCursor(s string) (timeIDCursor, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return timeIDCursor{}, errors.New("empty cursor")
	}
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return timeIDCursor{}, fmt.Errorf("cursor: %w", err)
	}
	var c timeIDCursor
	if err := json.Unmarshal(b, &c); err != nil {
		return timeIDCursor{}, fmt.Errorf("cursor json: %w", err)
	}
	if c.ID == uuid.Nil {
		return timeIDCursor{}, errors.New("cursor: missing id")
	}
	return c, nil
}
