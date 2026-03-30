package notify

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"cronsentinel/internal/envcrypto"
)

// SMTPSentinelJobChannelID is stored in job_alert_channels to include SMTP when using per-job custom routing.
var SMTPSentinelJobChannelID = uuid.MustParse("11111111-1111-1111-1111-111111111111")

// ChannelKind values for alert_channels.kind (non-SMTP rows).
const (
	ChannelSlackWebhook    = "slack_webhook"
	ChannelGenericWebhook  = "generic_webhook"
	ChannelSMSTwilio       = "sms_twilio"
	ChannelKindSMTP        = "smtp" // synthetic dispatch target, not in DB
)

// SlackWebhookConfigJSON is stored encrypted in alert_channels.
type SlackWebhookConfigJSON struct {
	WebhookURL string `json:"webhook_url"`
}

type GenericWebhookConfigJSON struct {
	URL string `json:"url"`
}

type TwilioSMSConfigJSON struct {
	AccountSID string `json:"account_sid"`
	AuthToken  string `json:"auth_token"`
	From       string `json:"from"`
	To         string `json:"to"`
}

// AlertChannelRow is a decrypted channel for dispatch or API masking.
type AlertChannelRow struct {
	ID      uuid.UUID
	Kind    string
	Label   string
	Enabled bool
	Slack   *SlackWebhookConfigJSON
	Webhook *GenericWebhookConfigJSON
	Twilio  *TwilioSMSConfigJSON
}

// HasEnabledExtraChannels reports whether any non-SMTP alert channel is enabled.
func HasEnabledExtraChannels(ctx context.Context, db *pgxpool.Pool) (bool, error) {
	var n int
	err := db.QueryRow(ctx, `select count(*)::int from alert_channels where enabled = true`).Scan(&n)
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// TransportAvailable is true if at least one delivery path exists (SMTP ready or any extra channel).
func TransportAvailable(ctx context.Context, db *pgxpool.Pool, s *Settings) bool {
	if s != nil && DeliverableSMTP(s) {
		return true
	}
	ok, err := HasEnabledExtraChannels(ctx, db)
	return err == nil && ok
}

// DeliverableSMTP is true when the singleton SMTP row can send mail.
func DeliverableSMTP(s *Settings) bool {
	return s != nil && s.Enabled && CanSend(s) && HasCredentials(s)
}

// DecryptAlertChannel loads one row and decrypts config.
func DecryptAlertChannel(ctx context.Context, db *pgxpool.Pool, key [32]byte, id uuid.UUID) (*AlertChannelRow, error) {
	var kind, label string
	var enabled bool
	var cipher []byte
	err := db.QueryRow(ctx,
		`select kind, label, enabled, config_ciphertext from alert_channels where id=$1`,
		id,
	).Scan(&kind, &label, &enabled, &cipher)
	if err != nil {
		return nil, err
	}
	if len(cipher) == 0 {
		return &AlertChannelRow{ID: id, Kind: kind, Label: label, Enabled: enabled}, nil
	}
	plain, err := envcrypto.Decrypt(key, cipher)
	if err != nil {
		return nil, fmt.Errorf("decrypt channel config: %w", err)
	}
	row := &AlertChannelRow{ID: id, Kind: kind, Label: label, Enabled: enabled}
	switch kind {
	case ChannelSlackWebhook:
		var c SlackWebhookConfigJSON
		if err := json.Unmarshal([]byte(plain), &c); err != nil {
			return nil, fmt.Errorf("slack config json: %w", err)
		}
		row.Slack = &c
	case ChannelGenericWebhook:
		var c GenericWebhookConfigJSON
		if err := json.Unmarshal([]byte(plain), &c); err != nil {
			return nil, fmt.Errorf("webhook config json: %w", err)
		}
		row.Webhook = &c
	case ChannelSMSTwilio:
		var c TwilioSMSConfigJSON
		if err := json.Unmarshal([]byte(plain), &c); err != nil {
			return nil, fmt.Errorf("twilio config json: %w", err)
		}
		row.Twilio = &c
	default:
		return nil, fmt.Errorf("unknown channel kind %q", kind)
	}
	return row, nil
}

// ListAlertChannels returns enabled flag and masked fields for the UI.
func ListAlertChannels(ctx context.Context, db *pgxpool.Pool) ([]ginAlertChannelListItem, error) {
	rows, err := db.Query(ctx, `select id, kind, label, enabled, length(config_ciphertext)::int, created_at from alert_channels order by created_at asc`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ginAlertChannelListItem
	for rows.Next() {
		var id uuid.UUID
		var kind, label string
		var enabled bool
		var cipherLen int
		var created time.Time
		if err := rows.Scan(&id, &kind, &label, &enabled, &cipherLen, &created); err != nil {
			return nil, err
		}
		item := ginAlertChannelListItem{
			ID:      id.String(),
			Kind:    kind,
			Label:   label,
			Enabled: enabled,
			Created: created.UTC().Format(time.RFC3339Nano),
		}
		switch kind {
		case ChannelSlackWebhook:
			item.SlackWebhookSet = cipherLen > 0
		case ChannelGenericWebhook:
			item.GenericWebhookSet = cipherLen > 0
		case ChannelSMSTwilio:
			item.TwilioConfigured = cipherLen > 0
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

// ginAlertChannelListItem is JSON for GET /api/settings/alert-channels (no gin import in types).
type ginAlertChannelListItem struct {
	ID                 string `json:"id"`
	Kind               string `json:"kind"`
	Label              string `json:"label"`
	Enabled            bool   `json:"enabled"`
	Created            string `json:"created_at"`
	SlackWebhookSet    bool   `json:"slack_webhook_set,omitempty"`
	GenericWebhookSet  bool   `json:"generic_webhook_set,omitempty"`
	TwilioConfigured   bool   `json:"twilio_configured,omitempty"`
}

// CreateAlertChannel inserts a new channel; secrets must be non-empty where required.
func CreateAlertChannel(ctx context.Context, db *pgxpool.Pool, key [32]byte, kind, label string, enabled bool, body map[string]json.RawMessage) (uuid.UUID, error) {
	kind = strings.TrimSpace(kind)
	label = strings.TrimSpace(label)
	id := uuid.New()
	cipher, err := buildEncryptedConfig(kind, body, key)
	if err != nil {
		return uuid.Nil, err
	}
	_, err = db.Exec(ctx,
		`insert into alert_channels(id, kind, label, enabled, config_ciphertext) values($1,$2,$3,$4,$5)`,
		id, kind, label, enabled, cipher,
	)
	if err != nil {
		return uuid.Nil, err
	}
	return id, nil
}

// UpdateAlertChannel updates label, enabled, and optionally replaces secrets when raw JSON keys are present.
func UpdateAlertChannel(ctx context.Context, db *pgxpool.Pool, key [32]byte, id uuid.UUID, label *string, enabled *bool, body map[string]json.RawMessage) error {
	row, err := DecryptAlertChannel(ctx, db, key, id)
	if err != nil {
		return err
	}
	newLabel := row.Label
	if label != nil {
		newLabel = strings.TrimSpace(*label)
	}
	newEn := row.Enabled
	if enabled != nil {
		newEn = *enabled
	}
	// merge config
	switch row.Kind {
	case ChannelSlackWebhook:
		s := row.Slack
		if s == nil {
			s = &SlackWebhookConfigJSON{}
		}
		if v, ok := body["webhook_url"]; ok {
			var u string
			if err := json.Unmarshal(v, &u); err != nil {
				return fmt.Errorf("webhook_url: %w", err)
			}
			if strings.TrimSpace(u) != "" {
				s.WebhookURL = strings.TrimSpace(u)
			}
		}
		b, err := json.Marshal(s)
		if err != nil {
			return err
		}
		cipher, err := envcrypto.Encrypt(key, string(b))
		if err != nil {
			return err
		}
		_, err = db.Exec(ctx, `update alert_channels set label=$2, enabled=$3, config_ciphertext=$4 where id=$1`, id, newLabel, newEn, cipher)
		return err
	case ChannelGenericWebhook:
		w := row.Webhook
		if w == nil {
			w = &GenericWebhookConfigJSON{}
		}
		if v, ok := body["url"]; ok {
			var u string
			if err := json.Unmarshal(v, &u); err != nil {
				return fmt.Errorf("url: %w", err)
			}
			if strings.TrimSpace(u) != "" {
				w.URL = strings.TrimSpace(u)
			}
		}
		b, err := json.Marshal(w)
		if err != nil {
			return err
		}
		cipher, err := envcrypto.Encrypt(key, string(b))
		if err != nil {
			return err
		}
		_, err = db.Exec(ctx, `update alert_channels set label=$2, enabled=$3, config_ciphertext=$4 where id=$1`, id, newLabel, newEn, cipher)
		return err
	case ChannelSMSTwilio:
		t := row.Twilio
		if t == nil {
			t = &TwilioSMSConfigJSON{}
		}
		if v, ok := body["account_sid"]; ok {
			var s string
			if err := json.Unmarshal(v, &s); err != nil {
				return fmt.Errorf("account_sid: %w", err)
			}
			if strings.TrimSpace(s) != "" {
				t.AccountSID = strings.TrimSpace(s)
			}
		}
		if v, ok := body["auth_token"]; ok {
			var s string
			if err := json.Unmarshal(v, &s); err != nil {
				return fmt.Errorf("auth_token: %w", err)
			}
			if strings.TrimSpace(s) != "" {
				t.AuthToken = strings.TrimSpace(s)
			}
		}
		if v, ok := body["from"]; ok {
			var s string
			if err := json.Unmarshal(v, &s); err != nil {
				return fmt.Errorf("from: %w", err)
			}
			if strings.TrimSpace(s) != "" {
				t.From = strings.TrimSpace(s)
			}
		}
		if v, ok := body["to"]; ok {
			var s string
			if err := json.Unmarshal(v, &s); err != nil {
				return fmt.Errorf("to: %w", err)
			}
			if strings.TrimSpace(s) != "" {
				t.To = strings.TrimSpace(s)
			}
		}
		b, err := json.Marshal(t)
		if err != nil {
			return err
		}
		cipher, err := envcrypto.Encrypt(key, string(b))
		if err != nil {
			return err
		}
		_, err = db.Exec(ctx, `update alert_channels set label=$2, enabled=$3, config_ciphertext=$4 where id=$1`, id, newLabel, newEn, cipher)
		return err
	default:
		return fmt.Errorf("unknown kind %q", row.Kind)
	}
}

func buildEncryptedConfig(kind string, body map[string]json.RawMessage, key [32]byte) ([]byte, error) {
	switch kind {
	case ChannelSlackWebhook:
		var u string
		if v, ok := body["webhook_url"]; ok {
			if err := json.Unmarshal(v, &u); err != nil {
				return nil, err
			}
		}
		u = strings.TrimSpace(u)
		if u == "" {
			return nil, errors.New("webhook_url is required")
		}
		b, err := json.Marshal(SlackWebhookConfigJSON{WebhookURL: u})
		if err != nil {
			return nil, err
		}
		return envcrypto.Encrypt(key, string(b))
	case ChannelGenericWebhook:
		var u string
		if v, ok := body["url"]; ok {
			if err := json.Unmarshal(v, &u); err != nil {
				return nil, err
			}
		}
		u = strings.TrimSpace(u)
		if u == "" {
			return nil, errors.New("url is required")
		}
		b, err := json.Marshal(GenericWebhookConfigJSON{URL: u})
		if err != nil {
			return nil, err
		}
		return envcrypto.Encrypt(key, string(b))
	case ChannelSMSTwilio:
		var t TwilioSMSConfigJSON
		if v, ok := body["account_sid"]; ok {
			if err := json.Unmarshal(v, &t.AccountSID); err != nil {
				return nil, err
			}
		}
		if v, ok := body["auth_token"]; ok {
			if err := json.Unmarshal(v, &t.AuthToken); err != nil {
				return nil, err
			}
		}
		if v, ok := body["from"]; ok {
			if err := json.Unmarshal(v, &t.From); err != nil {
				return nil, err
			}
		}
		if v, ok := body["to"]; ok {
			if err := json.Unmarshal(v, &t.To); err != nil {
				return nil, err
			}
		}
		t.AccountSID = strings.TrimSpace(t.AccountSID)
		t.AuthToken = strings.TrimSpace(t.AuthToken)
		t.From = strings.TrimSpace(t.From)
		t.To = strings.TrimSpace(t.To)
		if t.AccountSID == "" || t.AuthToken == "" || t.From == "" || t.To == "" {
			return nil, errors.New("account_sid, auth_token, from, and to are required for Twilio")
		}
		b, err := json.Marshal(t)
		if err != nil {
			return nil, err
		}
		return envcrypto.Encrypt(key, string(b))
	default:
		return nil, fmt.Errorf("unknown kind %q", kind)
	}
}

// DeleteAlertChannel removes a channel row and any per-job routing references.
func DeleteAlertChannel(ctx context.Context, db *pgxpool.Pool, id uuid.UUID) error {
	if _, err := db.Exec(ctx, `delete from job_alert_channels where channel_id=$1`, id); err != nil {
		return err
	}
	tag, err := db.Exec(ctx, `delete from alert_channels where id=$1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	return nil
}

// ReplaceJobAlertRouting sets default vs custom and optional channel id list (including SMTP sentinel).
func ReplaceJobAlertRouting(ctx context.Context, db *pgxpool.Pool, jobID uuid.UUID, useDefault bool, channelIDs []uuid.UUID) error {
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `update cron_jobs set alert_use_default_channels=$2 where id=$1`, jobID, useDefault); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `delete from job_alert_channels where job_id=$1`, jobID); err != nil {
		return err
	}
	if !useDefault {
		for _, cid := range channelIDs {
			if _, err := tx.Exec(ctx, `insert into job_alert_channels(job_id, channel_id) values($1,$2) on conflict do nothing`, jobID, cid); err != nil {
				return err
			}
		}
	}
	return tx.Commit(ctx)
}

// LoadJobAlertChannelIDs returns custom routing ids and use_default flag.
func LoadJobAlertChannelIDs(ctx context.Context, db *pgxpool.Pool, jobID uuid.UUID) (useDefault bool, ids []uuid.UUID, err error) {
	err = db.QueryRow(ctx, `select coalesce(alert_use_default_channels, true) from cron_jobs where id=$1`, jobID).Scan(&useDefault)
	if err != nil {
		return true, nil, err
	}
	if useDefault {
		return true, nil, nil
	}
	rows, err := db.Query(ctx, `select channel_id from job_alert_channels where job_id=$1 order by channel_id`, jobID)
	if err != nil {
		return useDefault, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return useDefault, nil, err
		}
		ids = append(ids, id)
	}
	return useDefault, ids, rows.Err()
}
