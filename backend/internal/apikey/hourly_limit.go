package apikey

import (
	"sync"
	"time"

	"github.com/google/uuid"
)

// HourlyLimiter enforces at most limit requests per rolling UTC hour bucket per API key id.
type HourlyLimiter struct {
	mu     sync.Mutex
	limit  int
	counts map[uuid.UUID]hourCount
}

type hourCount struct {
	hour int64
	n    int
}

// NewHourlyLimiter returns a limiter allowing up to limit calls per key per UTC hour.
func NewHourlyLimiter(limit int) *HourlyLimiter {
	if limit <= 0 {
		limit = 1000
	}
	return &HourlyLimiter{limit: limit, counts: make(map[uuid.UUID]hourCount)}
}

// Allow reports whether the key may proceed and records usage for the current hour bucket.
func (h *HourlyLimiter) Allow(id uuid.UUID, now time.Time) bool {
	bucket := now.UTC().Unix() / 3600
	h.mu.Lock()
	defer h.mu.Unlock()
	c, ok := h.counts[id]
	if !ok || c.hour != bucket {
		h.counts[id] = hourCount{hour: bucket, n: 1}
		return true
	}
	if c.n >= h.limit {
		return false
	}
	c.n++
	h.counts[id] = c
	return true
}
