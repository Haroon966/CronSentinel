package notify

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	AlertTypeRunCompleted     = "run_completed"
	AlertTypeHeartbeatMissed  = "heartbeat_missed"
	AlertTypeServerUnreachable = "server_unreachable"
	AlertTypeCrontabChanged   = "crontab_changed"
	AlertTypeTest             = "test"
)

// AlertPayload is the canonical JSON body for generic webhooks and logging context.
type AlertPayload struct {
	AlertType    string `json:"alert_type"`
	JobName      string `json:"job_name,omitempty"`
	Status       string `json:"status,omitempty"`
	ErrorMessage string `json:"error_message,omitempty"`
	Timestamp    string `json:"timestamp"`
	JobURL       string `json:"job_url,omitempty"`
	RunURL       string `json:"run_url,omitempty"`
	ServerHint   string `json:"server_hint,omitempty"`
}

// AlertBudgetFunc returns allowed=false to skip sending; blockReason is stored in delivery log as failure.
type AlertBudgetFunc func(ctx context.Context) (allowed bool, blockReason string)

// Dispatcher sends alerts to SMTP and alert_channels rows with retry and delivery logging.
type Dispatcher struct {
	DB          *pgxpool.Pool
	Key         [32]byte
	PublicBase  string
	HTTPClient  *http.Client
	AlertBudget AlertBudgetFunc
}

func (d *Dispatcher) httpc() *http.Client {
	if d.HTTPClient != nil {
		return d.HTTPClient
	}
	return http.DefaultClient
}

func trimPublicBase(s string) string {
	return strings.TrimRight(strings.TrimSpace(s), "/")
}

// JobDeepLink returns a UI URL for the jobs tab (path-based SPA routes).
func (d *Dispatcher) JobDeepLink(jobID uuid.UUID) string {
	b := trimPublicBase(d.PublicBase)
	if b == "" || jobID == uuid.Nil {
		return ""
	}
	return fmt.Sprintf("%s/jobs", b)
}

// RunDeepLink returns a UI URL for run history filtered to a job (PRD: /jobs/:id/history).
func (d *Dispatcher) RunDeepLink(jobID uuid.UUID) string {
	b := trimPublicBase(d.PublicBase)
	if b == "" || jobID == uuid.Nil {
		return ""
	}
	return fmt.Sprintf("%s/jobs/%s/history", b, url.QueryEscape(jobID.String()))
}

type dispatchTarget struct {
	Kind      string
	Label     string
	ChannelID *uuid.UUID
	Row       *AlertChannelRow
}

// DispatchSummary reports whether any channel succeeded.
type DispatchSummary struct {
	AnySuccess bool
}

// Dispatch sends to all resolved targets. includeSMTP controls the synthetic SMTP leg; s must be loaded when SMTP is used.
func (d *Dispatcher) Dispatch(ctx context.Context, s *Settings, jobID uuid.UUID, runID *uuid.UUID, alertType, serverHint string, payload AlertPayload, emailSubject, emailPlain string, globalJob bool, includeSMTP bool) DispatchSummary {
	var targets []dispatchTarget
	var err error
	if globalJob {
		targets, err = d.resolveAllAccountChannels(ctx, includeSMTP, s)
	} else {
		targets, err = d.resolveForJob(ctx, jobID, includeSMTP, s)
	}
	if err != nil {
		slog.Error("alert dispatch resolve", "err", err)
		return DispatchSummary{}
	}
	if len(targets) == 0 {
		return DispatchSummary{}
	}
	sum := DispatchSummary{}
	for _, t := range targets {
		if d.AlertBudget != nil {
			ok, reason := d.AlertBudget(ctx)
			if !ok {
				d.writeDeliveryLog(ctx, t, alertType, jobID, runID, serverHint, false, 0, errors.New(reason))
				continue
			}
		}
		attempts, lastErr := d.sendWithRetry(ctx, s, t, payload, emailSubject, emailPlain)
		ok := lastErr == nil
		if ok {
			sum.AnySuccess = true
		}
		d.writeDeliveryLog(ctx, t, alertType, jobID, runID, serverHint, ok, attempts, lastErr)
	}
	return sum
}

func (d *Dispatcher) resolveAllAccountChannels(ctx context.Context, includeSMTP bool, s *Settings) ([]dispatchTarget, error) {
	var out []dispatchTarget
	if includeSMTP && s != nil && DeliverableSMTP(s) {
		out = append(out, dispatchTarget{Kind: ChannelKindSMTP, Label: "Email (SMTP)"})
	}
	rows, err := d.DB.Query(ctx, `select id from alert_channels where enabled = true order by created_at asc`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		row, err := DecryptAlertChannel(ctx, d.DB, d.Key, id)
		if err != nil || row == nil || !row.Enabled {
			continue
		}
		cid := id
		out = append(out, dispatchTarget{Kind: row.Kind, Label: row.Label, ChannelID: &cid, Row: row})
	}
	return out, rows.Err()
}

func (d *Dispatcher) resolveForJob(ctx context.Context, jobID uuid.UUID, includeSMTP bool, s *Settings) ([]dispatchTarget, error) {
	var useDefault bool
	err := d.DB.QueryRow(ctx, `select coalesce(alert_use_default_channels, true) from cron_jobs where id=$1`, jobID).Scan(&useDefault)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return d.resolveAllAccountChannels(ctx, includeSMTP, s)
		}
		return nil, err
	}
	if useDefault {
		return d.resolveAllAccountChannels(ctx, includeSMTP, s)
	}
	rows, err := d.DB.Query(ctx, `select channel_id from job_alert_channels where job_id=$1 order by channel_id`, jobID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []dispatchTarget
	for rows.Next() {
		var cid uuid.UUID
		if err := rows.Scan(&cid); err != nil {
			return nil, err
		}
		if cid == SMTPSentinelJobChannelID {
			if includeSMTP && s != nil && DeliverableSMTP(s) {
				out = append(out, dispatchTarget{Kind: ChannelKindSMTP, Label: "Email (SMTP)"})
			}
			continue
		}
		row, err := DecryptAlertChannel(ctx, d.DB, d.Key, cid)
		if err != nil || row == nil || !row.Enabled {
			continue
		}
		id := cid
		out = append(out, dispatchTarget{Kind: row.Kind, Label: row.Label, ChannelID: &id, Row: row})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func (d *Dispatcher) sendWithRetry(ctx context.Context, s *Settings, t dispatchTarget, payload AlertPayload, emailSubject, emailPlain string) (attempts int, lastErr error) {
	var err error
	for attempt := 1; attempt <= 3; attempt++ {
		attempts = attempt
		err = d.sendOnce(ctx, s, t, payload, emailSubject, emailPlain)
		if err == nil {
			return attempt, nil
		}
		lastErr = err
		if attempt < 3 {
			// exponential backoff: 1s, 2s
			dur := time.Duration(1<<(attempt-1)) * time.Second
			select {
			case <-ctx.Done():
				return attempt, ctx.Err()
			case <-time.After(dur):
			}
		}
	}
	return attempts, lastErr
}

func (d *Dispatcher) sendOnce(ctx context.Context, s *Settings, t dispatchTarget, payload AlertPayload, emailSubject, emailPlain string) error {
	switch t.Kind {
	case ChannelKindSMTP:
		if s == nil || !DeliverableSMTP(s) {
			return errors.New("smtp not configured")
		}
		return SendPlain(s, emailSubject, emailPlain)
	case ChannelSlackWebhook:
		if t.Row == nil || t.Row.Slack == nil || strings.TrimSpace(t.Row.Slack.WebhookURL) == "" {
			return errors.New("slack webhook url missing")
		}
		return d.postSlack(ctx, t.Row.Slack.WebhookURL, payload, emailPlain)
	case ChannelGenericWebhook:
		if t.Row == nil || t.Row.Webhook == nil || strings.TrimSpace(t.Row.Webhook.URL) == "" {
			return errors.New("webhook url missing")
		}
		return d.postJSON(ctx, t.Row.Webhook.URL, payload)
	case ChannelSMSTwilio:
		if t.Row == nil || t.Row.Twilio == nil {
			return errors.New("twilio config missing")
		}
		return d.postTwilioSMS(ctx, t.Row.Twilio, payload, emailPlain)
	default:
		return fmt.Errorf("unknown target kind %q", t.Kind)
	}
}

func (d *Dispatcher) postSlack(ctx context.Context, hookURL string, payload AlertPayload, fallbackPlain string) error {
	text := formatSlackText(payload)
	if strings.TrimSpace(text) == "" {
		text = fallbackPlain
	}
	body, err := json.Marshal(map[string]string{"text": text})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, hookURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := d.httpc().Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return fmt.Errorf("slack webhook status %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
	return nil
}

func formatSlackText(p AlertPayload) string {
	var b strings.Builder
	fmt.Fprintf(&b, "*CronSentinel* — %s\n", p.AlertType)
	if p.JobName != "" {
		fmt.Fprintf(&b, "Job: %s\n", p.JobName)
	}
	if p.Status != "" {
		fmt.Fprintf(&b, "Status: %s\n", p.Status)
	}
	if p.ErrorMessage != "" {
		fmt.Fprintf(&b, "Detail: %s\n", p.ErrorMessage)
	}
	if p.ServerHint != "" {
		fmt.Fprintf(&b, "Server: %s\n", p.ServerHint)
	}
	fmt.Fprintf(&b, "Time: %s\n", p.Timestamp)
	if p.JobURL != "" {
		fmt.Fprintf(&b, "Job: %s\n", p.JobURL)
	}
	if p.RunURL != "" {
		fmt.Fprintf(&b, "Runs: %s\n", p.RunURL)
	}
	return b.String()
}

func (d *Dispatcher) postJSON(ctx context.Context, hookURL string, payload AlertPayload) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, hookURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := d.httpc().Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return fmt.Errorf("webhook status %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
	return nil
}

func (d *Dispatcher) postTwilioSMS(ctx context.Context, cfg *TwilioSMSConfigJSON, payload AlertPayload, fallbackPlain string) error {
	msg := formatSMS(payload, fallbackPlain)
	apiURL := fmt.Sprintf("https://api.twilio.com/2010-04-01/Accounts/%s/Messages.json", cfg.AccountSID)
	form := url.Values{}
	form.Set("To", cfg.To)
	form.Set("From", cfg.From)
	form.Set("Body", msg)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, apiURL, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.SetBasicAuth(cfg.AccountSID, cfg.AuthToken)
	resp, err := d.httpc().Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return fmt.Errorf("twilio status %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
	return nil
}

func formatSMS(p AlertPayload, fallback string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "[%s] ", p.AlertType)
	if p.JobName != "" {
		fmt.Fprintf(&b, "%s — ", p.JobName)
	}
	if p.Status != "" {
		fmt.Fprintf(&b, "%s. ", p.Status)
	}
	if p.ErrorMessage != "" {
		s := p.ErrorMessage
		if len(s) > 280 {
			s = s[:280] + "…"
		}
		fmt.Fprintf(&b, "%s ", s)
	}
	if b.Len() < 20 && fallback != "" {
		s := fallback
		if len(s) > 1200 {
			s = s[:1200] + "…"
		}
		return s
	}
	if p.JobURL != "" {
		fmt.Fprintf(&b, " %s", p.JobURL)
	}
	return strings.TrimSpace(b.String())
}

func (d *Dispatcher) writeDeliveryLog(ctx context.Context, t dispatchTarget, alertType string, jobID uuid.UUID, runID *uuid.UUID, serverHint string, ok bool, attempts int, sendErr error) {
	st := "failed"
	errMsg := ""
	if ok {
		st = "sent"
	} else if sendErr != nil {
		errMsg = sendErr.Error()
		if len(errMsg) > 2000 {
			errMsg = errMsg[:2000]
		}
	}
	logID := uuid.New()
	var chID any
	if t.ChannelID != nil {
		chID = *t.ChannelID
	} else {
		chID = nil
	}
	var jid any
	if jobID != uuid.Nil {
		jid = jobID
	} else {
		jid = nil
	}
	var rid any
	if runID != nil {
		rid = *runID
	} else {
		rid = nil
	}
	label := t.Label
	if label == "" {
		label = t.Kind
	}
	_, err := d.DB.Exec(ctx,
		`insert into alert_delivery_log(id, channel_id, channel_kind, channel_label, alert_type, job_id, run_id, server_hint, status, attempts, error_message)
		 values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
		logID, chID, t.Kind, label, alertType, jid, rid, serverHint, st, attempts, errMsg,
	)
	if err != nil {
		// best-effort
	}
}

// TestChannel sends a fixed test payload through a single stored channel (by id).
func (d *Dispatcher) TestChannel(ctx context.Context, channelID uuid.UUID) error {
	row, err := DecryptAlertChannel(ctx, d.DB, d.Key, channelID)
	if err != nil {
		return err
	}
	if !row.Enabled {
		return errors.New("channel is disabled")
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	p := AlertPayload{
		AlertType:    AlertTypeTest,
		JobName:      "CronSentinel",
		Status:       "test",
		ErrorMessage: "This is a test alert from CronSentinel settings.",
		Timestamp:    now,
		JobURL:       trimPublicBase(d.PublicBase),
	}
	cid := channelID
	t := dispatchTarget{Kind: row.Kind, Label: row.Label, ChannelID: &cid, Row: row}
	if d.AlertBudget != nil {
		ok, reason := d.AlertBudget(ctx)
		if !ok {
			d.writeDeliveryLog(ctx, t, AlertTypeTest, uuid.Nil, nil, "", false, 0, errors.New(reason))
			return errors.New(reason)
		}
	}
	attempts, lastErr := d.sendWithRetry(ctx, nil, t, p, "[CronSentinel] Test alert", "CronSentinel test — if you received this, the channel works.\nTime: "+now)
	d.writeDeliveryLog(ctx, t, AlertTypeTest, uuid.Nil, nil, "", lastErr == nil, attempts, lastErr)
	return lastErr
}

// QueryDeliveryLog returns recent log rows for the UI (cursor: RFC3339 nano + id).
func QueryDeliveryLog(ctx context.Context, db *pgxpool.Pool, limit int, cursorTime *time.Time, cursorID *uuid.UUID) ([]DeliveryLogRow, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	var rows pgx.Rows
	var err error
	if cursorTime != nil && cursorID != nil {
		rows, err = db.Query(ctx, `
select id, created_at, channel_id, channel_kind, channel_label, alert_type, job_id, run_id, server_hint, status, attempts, error_message
from alert_delivery_log
where (created_at, id) < ($1::timestamptz, $2::uuid)
order by created_at desc, id desc
limit $3`, *cursorTime, *cursorID, limit)
	} else {
		rows, err = db.Query(ctx, `
select id, created_at, channel_id, channel_kind, channel_label, alert_type, job_id, run_id, server_hint, status, attempts, error_message
from alert_delivery_log
order by created_at desc, id desc
limit $1`, limit)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []DeliveryLogRow
	for rows.Next() {
		var r DeliveryLogRow
		var chID, jid, rid *uuid.UUID
		var created time.Time
		if err := rows.Scan(&r.ID, &created, &chID, &r.ChannelKind, &r.ChannelLabel, &r.AlertType, &jid, &rid, &r.ServerHint, &r.Status, &r.Attempts, &r.ErrorMessage); err != nil {
			return nil, err
		}
		r.CreatedAt = created.UTC().Format(time.RFC3339Nano)
		if chID != nil {
			s := chID.String()
			r.ChannelID = &s
		}
		if jid != nil {
			s := jid.String()
			r.JobID = &s
		}
		if rid != nil {
			s := rid.String()
			r.RunID = &s
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// DeliveryLogRow is JSON-friendly log entry.
type DeliveryLogRow struct {
	ID           string  `json:"id"`
	CreatedAt    string  `json:"created_at"`
	ChannelID    *string `json:"channel_id,omitempty"`
	ChannelKind  string  `json:"channel_kind"`
	ChannelLabel string  `json:"channel_label"`
	AlertType    string  `json:"alert_type"`
	JobID        *string `json:"job_id,omitempty"`
	RunID        *string `json:"run_id,omitempty"`
	ServerHint   string  `json:"server_hint"`
	Status       string  `json:"status"`
	Attempts     int     `json:"attempts"`
	ErrorMessage string  `json:"error_message,omitempty"`
}
