package heartbeat

import (
	"sync"
	"time"
)

const DefaultPingMinInterval = 10 * time.Second

// TokenRateLimiter enforces a minimum interval between accepts per key (e.g. heartbeat token).
type TokenRateLimiter struct {
	mu    sync.Mutex
	last  map[string]time.Time
	minGap time.Duration
}

// NewTokenRateLimiter returns a limiter with the given minimum gap between accepts per key.
func NewTokenRateLimiter(minGap time.Duration) *TokenRateLimiter {
	if minGap <= 0 {
		minGap = DefaultPingMinInterval
	}
	return &TokenRateLimiter{
		last:   make(map[string]time.Time),
		minGap: minGap,
	}
}

// Allow reports whether the key may proceed; if true, records now as last time.
func (r *TokenRateLimiter) Allow(key string, now time.Time) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	prev, ok := r.last[key]
	if ok && now.Sub(prev) < r.minGap {
		return false
	}
	r.last[key] = now
	return true
}
