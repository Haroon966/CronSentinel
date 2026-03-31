package main

import (
	"database/sql"
	"errors"
	"log/slog"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// validDurationTrendRanges maps the ?range= param to a lookback duration.
var validDurationTrendRanges = map[string]time.Duration{
	"7d":  7 * 24 * time.Hour,
	"30d": 30 * 24 * time.Hour,
	"90d": 90 * 24 * time.Hour,
}

// durationTrendPoint is a single run data point returned by getDurationTrend.
type durationTrendPoint struct {
	RunID      string `json:"run_id"`
	StartedAt  string `json:"started_at"`
	DurationMs int64  `json:"duration_ms"`
	Status     string `json:"status"`
}

// durationTrendStats holds computed percentile values for the data set.
type durationTrendStats struct {
	P50 int64 `json:"p50"`
	P95 int64 `json:"p95"`
	P99 int64 `json:"p99"`
}

// getDurationTrend handles GET /api/jobs/:id/runs/duration-trend?range=7d|30d|90d.
// It returns per-run duration data points for the requested window along with p50/p95/p99 stats.
// Runs without a recorded duration_ms are excluded (e.g. still-running or legacy runs).
func (a *app) getDurationTrend(c *gin.Context) {
	idParam := strings.TrimSpace(c.Param("id"))
	jobUUID, err := uuid.Parse(idParam)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid job ID format"})
		return
	}

	rangeParam := strings.TrimSpace(c.DefaultQuery("range", "30d"))
	lookback, ok := validDurationTrendRanges[rangeParam]
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid range: use 7d, 30d, or 90d"})
		return
	}

	// Verify the job exists to return a clean 404 rather than an empty result set.
	var jobName string
	err = a.db.QueryRow(c.Request.Context(),
		`select name from cron_jobs where id = $1`,
		jobUUID,
	).Scan(&jobName)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "job not found"})
			return
		}
		slog.Error("getDurationTrend job lookup", "job_id", jobUUID, "err", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to resolve job"})
		return
	}

	since := time.Now().UTC().Add(-lookback)

	rows, err := a.db.Query(c.Request.Context(),
		`select id, started_at, duration_ms, status
		   from job_runs
		  where job_id = $1
		    and duration_ms is not null
		    and started_at >= $2
		  order by started_at asc`,
		jobUUID, since,
	)
	if err != nil {
		slog.Error("getDurationTrend query", "job_id", jobUUID, "err", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to query run durations"})
		return
	}
	defer rows.Close()

	points := make([]durationTrendPoint, 0)
	durations := make([]int64, 0)

	for rows.Next() {
		var id uuid.UUID
		var started time.Time
		var dur sql.NullInt64
		var status string
		if err := rows.Scan(&id, &started, &dur, &status); err != nil {
			slog.Error("getDurationTrend scan", "job_id", jobUUID, "err", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to read run row"})
			return
		}
		if !dur.Valid {
			continue
		}
		points = append(points, durationTrendPoint{
			RunID:      id.String(),
			StartedAt:  started.UTC().Format(time.RFC3339),
			DurationMs: dur.Int64,
			Status:     status,
		})
		durations = append(durations, dur.Int64)
	}
	if err := rows.Err(); err != nil {
		slog.Error("getDurationTrend rows", "job_id", jobUUID, "err", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "error iterating run rows"})
		return
	}

	sortedDurs := make([]int64, len(durations))
	copy(sortedDurs, durations)
	sort.Slice(sortedDurs, func(i, j int) bool { return sortedDurs[i] < sortedDurs[j] })

	stats := durationTrendStats{
		P50: computePercentile(sortedDurs, 50),
		P95: computePercentile(sortedDurs, 95),
		P99: computePercentile(sortedDurs, 99),
	}

	c.JSON(http.StatusOK, gin.H{
		"job_id": jobUUID.String(),
		"range":  rangeParam,
		"points": points,
		"stats":  stats,
	})
}

// computePercentile returns the p-th percentile (0 < p ≤ 100) of a sorted slice using the
// nearest-rank method. Returns 0 for an empty slice.
func computePercentile(sorted []int64, p float64) int64 {
	n := len(sorted)
	if n == 0 {
		return 0
	}
	rank := int(math.Ceil(p / 100.0 * float64(n)))
	if rank < 1 {
		rank = 1
	}
	if rank > n {
		rank = n
	}
	return sorted[rank-1]
}
