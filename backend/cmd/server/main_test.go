package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"cronsentinel/internal/envcrypto"
	"cronsentinel/internal/heartbeat"
	"cronsentinel/internal/pricing"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestCrontabSnapshotFingerprint(t *testing.T) {
	a := crontabSnapshotFingerprint("", "0 * * * *\n")
	b := crontabSnapshotFingerprint("", "0 * * * *\n")
	if a != b {
		t.Fatal("fingerprint should be stable for same input")
	}
	if crontabSnapshotFingerprint("", "1 * * * *\n") == a {
		t.Fatal("different content should change fingerprint")
	}
	if crontabSnapshotFingerprint("perm", "") == crontabSnapshotFingerprint("", "") {
		t.Fatal("error vs empty should differ")
	}
}

func TestServerReachabilityHealth(t *testing.T) {
	created := time.Date(2026, 3, 29, 12, 0, 0, 0, time.UTC)
	recent := created.Add(1 * time.Minute)
	if serverReachabilityHealth(created, &recent, created.Add(2*time.Minute)) != "ok" {
		t.Fatal("recent ping should be ok")
	}
	old := created.Add(-5 * time.Minute)
	if serverReachabilityHealth(created, &old, created.Add(2*time.Minute)) != "stale" {
		t.Fatal("old ping should be stale")
	}
	if serverReachabilityHealth(created, nil, created.Add(1*time.Minute)) != "pending" {
		t.Fatal("no ping yet on new server should be pending")
	}
	if serverReachabilityHealth(created, nil, created.Add(5*time.Minute)) != "stale" {
		t.Fatal("never pinged after silence window should be stale")
	}
}

func TestParseRFC3339Query(t *testing.T) {
	p, err := parseRFC3339Query("")
	if err != nil || p != nil {
		t.Fatalf("empty: %v %v", p, err)
	}
	p, err = parseRFC3339Query("2026-03-28T12:00:00Z")
	if err != nil || p == nil || !p.Equal(time.Date(2026, 3, 28, 12, 0, 0, 0, time.UTC)) {
		t.Fatalf("parse: %v %v", p, err)
	}
}

func TestBuildRunsWhereFailedIncludesTimedOut(t *testing.T) {
	where, args, _, err := buildRunsWhere("failed", "", "", nil, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(where) != 1 || len(args) != 2 {
		t.Fatalf("where=%v args=%v", where, args)
	}
	if args[0] != "failure" || args[1] != "timed_out" {
		t.Fatalf("args: %v", args)
	}
}

func TestBuildRunsWhereTimedOutOnly(t *testing.T) {
	where, args, _, err := buildRunsWhere("timed_out", "", "", nil, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(where) != 1 || len(args) != 1 || args[0] != "timed_out" {
		t.Fatalf("where=%v args=%v", where, args)
	}
}

func TestBuildRunsWhereDateAndDuration(t *testing.T) {
	t1 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	t2 := time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC)
	minMs := 500
	maxMs := 120_000
	where, args, n, err := buildRunsWhere("all", "", "", &t1, &t2, &minMs, &maxMs)
	if err != nil {
		t.Fatal(err)
	}
	if len(where) != 4 {
		t.Fatalf("where: %v", where)
	}
	if len(args) != 4 {
		t.Fatalf("args len %d", len(args))
	}
	if n != 5 {
		t.Fatalf("argN want 5 got %d", n)
	}
}

func TestCronMatch(t *testing.T) {
	now := time.Date(2026, 1, 5, 10, 30, 0, 0, time.UTC)
	if !heartbeat.MatchesCron("* * * * *", now) {
		t.Fatal("wildcard cron should match")
	}
	if !heartbeat.MatchesCron("30 10 * * *", now) {
		t.Fatal("exact cron should match")
	}
	if heartbeat.MatchesCron("31 10 * * *", now) {
		t.Fatal("non-matching minute should fail")
	}
	if !heartbeat.MatchesCron("*/5 * * * *", time.Date(2026, 1, 5, 10, 35, 0, 0, time.UTC)) {
		t.Fatal("step cron should match 35")
	}
}

func TestDiagnoseError(t *testing.T) {
	reason, fix := diagnoseError(context.DeadlineExceeded, "")
	if reason == "" || fix == "" {
		t.Fatal("timeout diagnosis should not be empty")
	}
	reason, fix = diagnoseError(nil, "permission denied")
	if reason == "" || fix == "" {
		t.Fatal("permission diagnosis should not be empty")
	}
}

func TestCsvEscapeField(t *testing.T) {
	cases := []struct{ in, want string }{
		{"plain", "plain"},
		{"a,b", `"a,b"`},
		{`say "hi"`, `"say ""hi"""`},
		{"line1\nline2", "\"line1\nline2\""},
		{"tab\there", "\"tab\there\""},
	}
	for _, tc := range cases {
		got := csvEscapeField(tc.in)
		if got != tc.want {
			t.Fatalf("csvEscapeField(%q): want %q got %q", tc.in, tc.want, got)
		}
	}
}

func TestJobOverallStatus(t *testing.T) {
	cases := []struct {
		hasHB    bool
		hb       string
		lastRun  string
		want     string
	}{
		{true, heartbeat.StatusHealthy, "", "healthy"},
		{true, heartbeat.StatusHealthy, "failure", "healthy"},
		{true, heartbeat.StatusLate, "", "late"},
		{true, heartbeat.StatusDead, "", "failed"},
		{true, heartbeat.StatusNever, "", "never_run"},
		{true, heartbeat.StatusNever, "success", "healthy"},
		{true, heartbeat.StatusNever, "failure", "failed"},
		{true, heartbeat.StatusNever, "running", "running"},
		{false, "", "", "never_run"},
		{false, "", "success", "healthy"},
		{false, "", "failure", "failed"},
		{false, "", "timed_out", "failed"},
		{true, heartbeat.StatusNever, "timed_out", "failed"},
		{false, "", "running", "running"},
	}
	for _, tc := range cases {
		got := jobOverallStatus(tc.hasHB, tc.hb, tc.lastRun)
		if got != tc.want {
			t.Fatalf("hasHB=%v hb=%q lastRun=%q: want %q got %q", tc.hasHB, tc.hb, tc.lastRun, tc.want, got)
		}
	}
}

// TestIntegrationCreateJobReturnsHeartbeatToken requires PostgreSQL (DATABASE_URL or default localhost).
func TestIntegrationCreateJobReturnsHeartbeatToken(t *testing.T) {
	ctx := context.Background()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		url = "postgres://postgres:postgres@127.0.0.1:5432/cronsentinel?sslmode=disable"
	}
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Skip("integration: could not create pool:", err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		t.Skip("integration: database unreachable:", err)
	}

	tmp := t.TempDir()
	envKey, _, kerr := envcrypto.LoadKey()
	if kerr != nil {
		t.Fatal(kerr)
	}
	a := &app{
		db:              pool,
		scriptDir:       tmp,
		subscribers:     make(map[string][]chan string),
		lastTickRun:     make(map[string]time.Time),
		hbLimiter:       heartbeat.NewTokenRateLimiter(10 * time.Second),
		srvHbLimiter:    heartbeat.NewTokenRateLimiter(30 * time.Second),
		cronSnapLimiter: heartbeat.NewTokenRateLimiter(60 * time.Second),
		envFetchLimiter: heartbeat.NewTokenRateLimiter(2 * time.Second),
		envKey:          envKey,
	}
	if err := a.ensureSchema(ctx); err != nil {
		t.Fatal(err)
	}

	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.POST("/api/jobs", a.createJob)

	name := "integration-create-job-" + strconv.FormatInt(time.Now().UnixNano(), 10)
	payload := `{"name":` + jsonQuote(name) + `,"schedule":"0 * * * *","command":"echo hi","timezone":"Local","logging_enabled":true,"timeout_seconds":300,"heartbeat_grace_seconds":300,"success_exit_code":0}`
	req := httptest.NewRequest(http.MethodPost, "/api/jobs", strings.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("want 201 got %d: %s", w.Code, w.Body.String())
	}
	var out struct {
		OK             bool   `json:"ok"`
		ID             string `json:"id"`
		HeartbeatToken string `json:"heartbeat_token"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if !out.OK || out.ID == "" || len(out.HeartbeatToken) < 16 {
		t.Fatalf("response: %+v raw=%s", out, w.Body.String())
	}
}

func jsonQuote(s string) string {
	b, err := json.Marshal(s)
	if err != nil {
		panic(err)
	}
	return string(b)
}

// TestIntegrationMonitorLimitEnforced requires PostgreSQL; uses a temp pricing file with max_monitors=1.
func TestIntegrationMonitorLimitEnforced(t *testing.T) {
	ctx := context.Background()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		url = "postgres://postgres:postgres@127.0.0.1:5432/cronsentinel?sslmode=disable"
	}
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Skip("integration: could not create pool:", err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		t.Skip("integration: database unreachable:", err)
	}

	tmp := t.TempDir()
	pricingPath := filepath.Join(tmp, "pricing.json")
	cfg := `{"tiers":[{"slug":"free","display_name":"Free","max_monitors":1,"max_alerts_per_month":100,"upgrade_url":"https://example.com"}]}`
	if err := os.WriteFile(pricingPath, []byte(cfg), 0o644); err != nil {
		t.Fatal(err)
	}
	ps, err := pricing.LoadFile(pricingPath)
	if err != nil {
		t.Fatal(err)
	}
	ps.BindDB(pool)

	tmpDir := t.TempDir()
	envKey, _, kerr := envcrypto.LoadKey()
	if kerr != nil {
		t.Fatal(kerr)
	}
	a := &app{
		db:              pool,
		scriptDir:       tmpDir,
		subscribers:     make(map[string][]chan string),
		lastTickRun:     make(map[string]time.Time),
		hbLimiter:       heartbeat.NewTokenRateLimiter(10 * time.Second),
		srvHbLimiter:    heartbeat.NewTokenRateLimiter(30 * time.Second),
		cronSnapLimiter: heartbeat.NewTokenRateLimiter(60 * time.Second),
		envFetchLimiter: heartbeat.NewTokenRateLimiter(2 * time.Second),
		envKey:          envKey,
		pricing:         ps,
	}
	if err := a.ensureSchema(ctx); err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `delete from cron_jobs where name like 'pricing-limit-test-%'`)
	if err != nil {
		t.Fatal(err)
	}

	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.POST("/api/jobs", a.createJob)

	payload := func(name string) string {
		return `{"name":` + jsonQuote(name) + `,"schedule":"0 * * * *","command":"echo hi","timezone":"Local","logging_enabled":true,"timeout_seconds":300,"heartbeat_grace_seconds":300,"success_exit_code":0}`
	}
	req1 := httptest.NewRequest(http.MethodPost, "/api/jobs", strings.NewReader(payload("pricing-limit-test-a")))
	req1.Header.Set("Content-Type", "application/json")
	w1 := httptest.NewRecorder()
	r.ServeHTTP(w1, req1)
	if w1.Code != http.StatusCreated {
		t.Fatalf("first create want 201 got %d: %s", w1.Code, w1.Body.String())
	}

	req2 := httptest.NewRequest(http.MethodPost, "/api/jobs", strings.NewReader(payload("pricing-limit-test-b")))
	req2.Header.Set("Content-Type", "application/json")
	w2 := httptest.NewRecorder()
	r.ServeHTTP(w2, req2)
	if w2.Code != http.StatusConflict {
		t.Fatalf("second create want 409 got %d: %s", w2.Code, w2.Body.String())
	}
}
