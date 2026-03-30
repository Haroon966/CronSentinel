package pricing

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed default_pricing.json
var defaultPricingEmbedded []byte

// Tier is one pricing tier loaded from config (not hardcoded in business logic).
type Tier struct {
	Slug               string `json:"slug"`
	DisplayName        string `json:"display_name"`
	MaxMonitors        int    `json:"max_monitors"`
	MaxAlertsPerMonth  int    `json:"max_alerts_per_month"`
	UpgradeURL         string `json:"upgrade_url"`
}

type fileConfig struct {
	Tiers []Tier `json:"tiers"`
}

// Service resolves plan limits and usage for the single-tenant deployment.
type Service struct {
	DB     *pgxpool.Pool
	bySlug map[string]Tier
	order  []Tier
}

// BindDB attaches the pool after LoadConfigured (required before API use).
func (s *Service) BindDB(db *pgxpool.Pool) {
	s.DB = db
}

func parseConfig(b []byte) (*Service, error) {
	var fc fileConfig
	if err := json.Unmarshal(b, &fc); err != nil {
		return nil, fmt.Errorf("parse pricing config: %w", err)
	}
	if len(fc.Tiers) == 0 {
		return nil, errors.New("pricing config: no tiers")
	}
	by := make(map[string]Tier, len(fc.Tiers))
	for _, t := range fc.Tiers {
		slug := strings.TrimSpace(t.Slug)
		if slug == "" {
			return nil, errors.New("pricing config: empty tier slug")
		}
		if t.MaxMonitors < 0 || t.MaxAlertsPerMonth < 0 {
			return nil, fmt.Errorf("pricing config: negative limits for tier %q", slug)
		}
		t.Slug = slug
		by[slug] = t
	}
	return &Service{bySlug: by, order: fc.Tiers}, nil
}

// LoadEmbedded returns the compiled-in default tiers.
func LoadEmbedded() (*Service, error) {
	return parseConfig(defaultPricingEmbedded)
}

// LoadFile reads pricing JSON from path.
func LoadFile(path string) (*Service, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read pricing config: %w", err)
	}
	return parseConfig(b)
}

// LoadConfigured loads CRONSENTINEL_PRICING_CONFIG when set, otherwise embedded defaults.
func LoadConfigured() (*Service, error) {
	path := strings.TrimSpace(os.Getenv("CRONSENTINEL_PRICING_CONFIG"))
	if path != "" {
		return LoadFile(path)
	}
	return LoadEmbedded()
}

// DefaultTier returns the first tier in file order (fallback for unknown slugs).
func (s *Service) DefaultTier() Tier {
	if len(s.order) > 0 {
		return s.order[0]
	}
	return Tier{Slug: "free", DisplayName: "Free", MaxMonitors: 50, MaxAlertsPerMonth: 500}
}

// TierBySlug returns a tier or false if unknown.
func (s *Service) TierBySlug(slug string) (Tier, bool) {
	t, ok := s.bySlug[strings.TrimSpace(slug)]
	return t, ok
}

// EffectivePlanSlug returns CRONSENTINEL_PLAN env if set, else account_billing.plan_slug.
func (s *Service) EffectivePlanSlug(ctx context.Context) (string, error) {
	if v := strings.TrimSpace(os.Getenv("CRONSENTINEL_PLAN")); v != "" {
		return v, nil
	}
	var slug string
	err := s.DB.QueryRow(ctx, `select plan_slug from account_billing where id = 1`).Scan(&slug)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(slug), nil
}

// ResolveTier returns the tier for the effective plan, or the default tier if slug is unknown.
func (s *Service) ResolveTier(ctx context.Context) Tier {
	slug, err := s.EffectivePlanSlug(ctx)
	if err != nil {
		slog.Error("pricing EffectivePlanSlug", "err", err)
		return s.DefaultTier()
	}
	if t, ok := s.TierBySlug(slug); ok {
		return t
	}
	slog.Warn("pricing unknown plan slug, using default tier", "slug", slug)
	return s.DefaultTier()
}

// MonitorCount returns total rows in cron_jobs (all jobs count as monitors per FEAT-16).
func (s *Service) MonitorCount(ctx context.Context) (int64, error) {
	var n int64
	err := s.DB.QueryRow(ctx, `select count(*) from cron_jobs`).Scan(&n)
	return n, err
}

// AlertsSentThisMonthUTC counts successful deliveries in the current UTC calendar month.
func (s *Service) AlertsSentThisMonthUTC(ctx context.Context) (int64, error) {
	var n int64
	err := s.DB.QueryRow(ctx, `
select count(*) from alert_delivery_log
where status = 'sent'
  and to_char(created_at at time zone 'UTC', 'YYYY-MM')
      = to_char((now() at time zone 'utc'), 'YYYY-MM')
`).Scan(&n)
	return n, err
}

// ErrMonitorLimit is returned when creating a job would exceed the plan.
var ErrMonitorLimit = errors.New("monitor limit reached")

// ErrPlanLockedByEnv is returned when CRONSENTINEL_PLAN overrides database plan.
var ErrPlanLockedByEnv = errors.New("plan is controlled by CRONSENTINEL_PLAN")

// ErrUnknownPlanSlug is returned for an invalid plan_slug in PATCH.
var ErrUnknownPlanSlug = errors.New("unknown plan slug")

// ErrPlanSlugRequired is returned when plan_slug is empty in PATCH.
var ErrPlanSlugRequired = errors.New("plan_slug is required")

// CheckCreateMonitor returns nil if a new monitor is allowed, or ErrMonitorLimit with context in message via API layer.
func (s *Service) CheckCreateMonitor(ctx context.Context) error {
	tier := s.ResolveTier(ctx)
	max := tier.MaxMonitors
	if max <= 0 {
		max = 0
	}
	n, err := s.MonitorCount(ctx)
	if err != nil {
		return fmt.Errorf("monitor count: %w", err)
	}
	if int(n) >= max {
		return ErrMonitorLimit
	}
	return nil
}

// CanSendAlert returns whether one more alert delivery log row (sent) is allowed this month.
func (s *Service) CanSendAlert(ctx context.Context) (allowed bool, blockReason string) {
	tier := s.ResolveTier(ctx)
	max := tier.MaxAlertsPerMonth
	if max <= 0 {
		return false, "Monthly alert limit is not configured for your plan."
	}
	used, err := s.AlertsSentThisMonthUTC(ctx)
	if err != nil {
		slog.Error("pricing AlertsSentThisMonthUTC", "err", err)
		return true, ""
	}
	if int64(max) <= used {
		return false, fmt.Sprintf("Monthly alert limit reached (%d/%d) for plan %q. Upgrade your plan to send more notifications.", used, max, tier.DisplayName)
	}
	return true, ""
}

// UsageDTO is returned by GET /api/settings/billing.
type UsageDTO struct {
	PlanSlug              string  `json:"plan_slug"`
	PlanDisplayName       string  `json:"plan_display_name"`
	PlanSource            string  `json:"plan_source"`
	MaxMonitors           int     `json:"max_monitors"`
	MaxAlertsPerMonth     int     `json:"max_alerts_per_month"`
	MonitorsUsed          int64   `json:"monitors_used"`
	AlertsSentThisMonth   int64   `json:"alerts_sent_this_month"`
	MonitorsUtilization   float64 `json:"monitors_utilization"`
	AlertsUtilization     float64 `json:"alerts_utilization"`
	UpgradeURL            string  `json:"upgrade_url"`
	AvailablePlanSlugs    []string `json:"available_plan_slugs"`
}

// Snapshot builds usage for the settings UI.
func (s *Service) Snapshot(ctx context.Context) (UsageDTO, error) {
	envOverride := strings.TrimSpace(os.Getenv("CRONSENTINEL_PLAN")) != ""
	slug, err := s.EffectivePlanSlug(ctx)
	if err != nil {
		return UsageDTO{}, err
	}
	tier := s.ResolveTier(ctx)
	usedMon, err := s.MonitorCount(ctx)
	if err != nil {
		return UsageDTO{}, err
	}
	usedAlert, err := s.AlertsSentThisMonthUTC(ctx)
	if err != nil {
		return UsageDTO{}, err
	}
	src := "database"
	if envOverride {
		src = "environment"
	}
	mUtil := 0.0
	if tier.MaxMonitors > 0 {
		mUtil = float64(usedMon) / float64(tier.MaxMonitors)
	}
	aUtil := 0.0
	if tier.MaxAlertsPerMonth > 0 {
		aUtil = float64(usedAlert) / float64(tier.MaxAlertsPerMonth)
	}
	slugs := make([]string, 0, len(s.order))
	for _, t := range s.order {
		slugs = append(slugs, t.Slug)
	}
	return UsageDTO{
		PlanSlug:            slug,
		PlanDisplayName:     tier.DisplayName,
		PlanSource:          src,
		MaxMonitors:         tier.MaxMonitors,
		MaxAlertsPerMonth:   tier.MaxAlertsPerMonth,
		MonitorsUsed:        usedMon,
		AlertsSentThisMonth: usedAlert,
		MonitorsUtilization: mUtil,
		AlertsUtilization:   aUtil,
		UpgradeURL:          tier.UpgradeURL,
		AvailablePlanSlugs:  slugs,
	}, nil
}

// SetPlanSlug updates the persisted plan (ignored when CRONSENTINEL_PLAN is set).
func (s *Service) SetPlanSlug(ctx context.Context, slug string) error {
	if strings.TrimSpace(os.Getenv("CRONSENTINEL_PLAN")) != "" {
		return ErrPlanLockedByEnv
	}
	slug = strings.TrimSpace(slug)
	if slug == "" {
		return ErrPlanSlugRequired
	}
	if _, ok := s.TierBySlug(slug); !ok {
		return fmt.Errorf("%w (%q)", ErrUnknownPlanSlug, slug)
	}
	_, err := s.DB.Exec(ctx, `update account_billing set plan_slug=$1, updated_at=now() where id=1`, slug)
	return err
}
