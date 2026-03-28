// Package notify sends email via SMTP using notification_settings from the database.
package notify

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/smtp"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const settingsRowID = 1

// Settings holds a row from notification_settings (password may be empty in API responses).
type Settings struct {
	Enabled                 bool
	SMTPHost                string
	SMTPPort                int
	SMTPUsername            string
	SMTPPassword            string
	SMTPTLS                 bool
	FromAddress             string
	ToAddresses             string
	NotifyScheduledSuccess  bool
	NotifyScheduledFailure  bool
	NotifyManualSuccess     bool
	NotifyManualFailure     bool
	NotifyHeartbeatMissed   bool
}

// Load reads the singleton notification_settings row.
func Load(ctx context.Context, db *pgxpool.Pool) (*Settings, error) {
	var s Settings
	err := db.QueryRow(ctx, `
select enabled, coalesce(smtp_host,''), smtp_port, coalesce(smtp_username,''), coalesce(smtp_password,''),
       smtp_tls, coalesce(from_address,''), coalesce(to_addresses,''),
       notify_scheduled_success, notify_scheduled_failure, notify_manual_success, notify_manual_failure,
       coalesce(notify_heartbeat_missed, false)
from notification_settings where id = $1
`, settingsRowID).Scan(
		&s.Enabled, &s.SMTPHost, &s.SMTPPort, &s.SMTPUsername, &s.SMTPPassword,
		&s.SMTPTLS, &s.FromAddress, &s.ToAddresses,
		&s.NotifyScheduledSuccess, &s.NotifyScheduledFailure, &s.NotifyManualSuccess, &s.NotifyManualFailure,
		&s.NotifyHeartbeatMissed,
	)
	if err != nil {
		return nil, err
	}
	return &s, nil
}

// EffectivePassword returns NOTIFICATION_SMTP_PASSWORD if set, else DB password.
func EffectivePassword(s *Settings) string {
	if e := strings.TrimSpace(os.Getenv("NOTIFICATION_SMTP_PASSWORD")); e != "" {
		return e
	}
	return s.SMTPPassword
}

// ParseRecipients splits comma-separated addresses.
func ParseRecipients(raw string) []string {
	var out []string
	for _, p := range strings.Split(raw, ",") {
		a := strings.TrimSpace(p)
		if a != "" {
			out = append(out, a)
		}
	}
	return out
}

// CanSend reports whether SMTP is minimally configured for sending.
func CanSend(s *Settings) bool {
	if !s.Enabled {
		return false
	}
	if strings.TrimSpace(s.SMTPHost) == "" || s.SMTPPort <= 0 || s.SMTPPort > 65535 {
		return false
	}
	if strings.TrimSpace(s.FromAddress) == "" {
		return false
	}
	if len(ParseRecipients(s.ToAddresses)) == 0 {
		return false
	}
	return true
}

// HasCredentials reports whether a password is present when a username is set (required for most providers like Hostinger).
func HasCredentials(s *Settings) bool {
	user := strings.TrimSpace(s.SMTPUsername)
	if user == "" {
		return true
	}
	return strings.TrimSpace(EffectivePassword(s)) != ""
}

// ShouldNotifyRun returns whether a completed run should trigger email per toggles.
func ShouldNotifyRun(s *Settings, trigger, status string) bool {
	if !s.Enabled {
		return false
	}
	t := strings.ToLower(strings.TrimSpace(trigger))
	st := strings.ToLower(strings.TrimSpace(status))
	if st != "success" && st != "failure" {
		return false
	}
	if t == "scheduled" {
		if st == "success" {
			return s.NotifyScheduledSuccess
		}
		return s.NotifyScheduledFailure
	}
	if t == "manual" {
		if st == "success" {
			return s.NotifyManualSuccess
		}
		return s.NotifyManualFailure
	}
	return false
}

// ShouldNotifyHeartbeatMissed reports whether missed-heartbeat alerts are enabled and SMTP is usable.
func ShouldNotifyHeartbeatMissed(s *Settings) bool {
	return s != nil && s.Enabled && s.NotifyHeartbeatMissed && CanSend(s) && HasCredentials(s)
}

// FormatHeartbeatMissed builds subject and body for a missed heartbeat alert.
func FormatHeartbeatMissed(jobName, status, scheduledRFC, deadlineRFC string, minutesLate int, lastPing string) (subject, body string) {
	subject = fmt.Sprintf("[CronSentinel] Heartbeat missed — %s", jobName)
	var b strings.Builder
	fmt.Fprintf(&b, "Job: %s\n", jobName)
	fmt.Fprintf(&b, "Status: %s\n", status)
	fmt.Fprintf(&b, "Scheduled run time: %s\n", scheduledRFC)
	fmt.Fprintf(&b, "Minutes late (since scheduled run): %d\n", minutesLate)
	fmt.Fprintf(&b, "Ping expected by: %s\n", deadlineRFC)
	if lastPing != "" {
		fmt.Fprintf(&b, "Last ping: %s\n", lastPing)
	} else {
		b.WriteString("Last ping: (never)\n")
	}
	b.WriteString("\nSend a POST to the job heartbeat URL after each successful run.\n")
	return subject, b.String()
}

const smtpMaxAttempts = 3

// SendPlainWithRetry attempts SendPlain up to smtpMaxAttempts times with backoff between failures.
func SendPlainWithRetry(s *Settings, subject, body string) error {
	var lastErr error
	for attempt := 1; attempt <= smtpMaxAttempts; attempt++ {
		lastErr = SendPlain(s, subject, body)
		if lastErr == nil {
			return nil
		}
		if attempt < smtpMaxAttempts {
			time.Sleep(time.Duration(attempt) * time.Second)
		}
	}
	return fmt.Errorf("smtp failed after %d attempts: %w", smtpMaxAttempts, lastErr)
}

const maxSnippet = 4000

// FormatRunCompleted builds subject and plain body for a single run.
func FormatRunCompleted(jobName, command, status string, runID string, exitCode *int, failureReason, stdout, stderr string) (subject, body string) {
	subject = fmt.Sprintf("[CronSentinel] %s — %s", jobName, strings.ToUpper(status))
	var b strings.Builder
	fmt.Fprintf(&b, "Job: %s\nRun ID: %s\nStatus: %s\n", jobName, runID, status)
	if exitCode != nil {
		fmt.Fprintf(&b, "Exit code: %d\n", *exitCode)
	}
	fmt.Fprintf(&b, "Command: %s\n", command)
	if failureReason != "" {
		fmt.Fprintf(&b, "Failure reason: %s\n", failureReason)
	}
	if stdout != "" {
		sn := stdout
		if len(sn) > maxSnippet {
			sn = sn[:maxSnippet] + "\n… (truncated)"
		}
		fmt.Fprintf(&b, "\n--- STDOUT ---\n%s\n", sn)
	}
	if stderr != "" {
		sn := stderr
		if len(sn) > maxSnippet {
			sn = sn[:maxSnippet] + "\n… (truncated)"
		}
		fmt.Fprintf(&b, "\n--- STDERR ---\n%s\n", sn)
	}
	return subject, b.String()
}

// FormatRunHistoryEmail builds subject and body for a batch of runs (metadata only).
func FormatRunHistoryEmail(runs []HistoryRun) (subject, body string) {
	subject = fmt.Sprintf("[CronSentinel] Run history (%d runs)", len(runs))
	var b strings.Builder
	b.WriteString("Run history export (newest first).\n\n")
	for i, r := range runs {
		fmt.Fprintf(&b, "── Run %d ──\n", i+1)
		fmt.Fprintf(&b, "ID: %s\nJob: %s\nStatus: %s\n", r.ID, r.JobName, r.Status)
		if r.Command != "" {
			fmt.Fprintf(&b, "Command: %s\n", r.Command)
		}
		if r.ExitCode != nil {
			fmt.Fprintf(&b, "Exit: %d\n", *r.ExitCode)
		}
		fmt.Fprintf(&b, "Started: %s\n", r.StartedAt)
		if r.EndedAt != "" {
			fmt.Fprintf(&b, "Ended: %s\n", r.EndedAt)
		}
		if r.FailureReason != "" {
			fmt.Fprintf(&b, "Failure: %s\n", r.FailureReason)
		}
		b.WriteByte('\n')
	}
	return subject, b.String()
}

// HistoryRun is one row for history export.
type HistoryRun struct {
	ID            string
	JobName       string
	Command       string
	Status        string
	ExitCode      *int
	StartedAt     string
	EndedAt       string
	FailureReason string
}

// SendPlain sends a UTF-8 plain-text email.
func SendPlain(s *Settings, subject, body string) error {
	host := strings.TrimSpace(s.SMTPHost)
	port := s.SMTPPort
	from := strings.TrimSpace(s.FromAddress)
	to := ParseRecipients(s.ToAddresses)
	pass := EffectivePassword(s)
	user := strings.TrimSpace(s.SMTPUsername)

	if !CanSend(s) {
		return fmt.Errorf("notification settings incomplete or disabled")
	}

	addr := fmt.Sprintf("%s:%d", host, port)
	headers := fmt.Sprintf("From: %s\r\nTo: %s\r\nSubject: %s\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n",
		from, strings.Join(to, ", "), encodeSubject(subject))

	msg := []byte(headers + body)

	dialer := &net.Dialer{Timeout: 25 * time.Second}

	var c *smtp.Client
	var err error

	// Port 465: implicit TLS (STARTTLS setting is ignored; connection is already encrypted)
	if port == 465 {
		tlsCfg := &tls.Config{
			ServerName: host,
			MinVersion: tls.VersionTLS12,
		}
		rawConn, e := dialer.Dial("tcp", addr)
		if e != nil {
			return fmt.Errorf("tcp dial (port 465): %w", e)
		}
		tlsConn := tls.Client(rawConn, tlsCfg)
		if e := tlsConn.Handshake(); e != nil {
			_ = rawConn.Close()
			return fmt.Errorf("tls handshake (port 465): %w", e)
		}
		c, err = smtp.NewClient(tlsConn, host)
		if err != nil {
			_ = rawConn.Close()
			return fmt.Errorf("smtp client: %w", err)
		}
	} else {
		rawConn, e := dialer.Dial("tcp", addr)
		if e != nil {
			return fmt.Errorf("smtp dial: %w", e)
		}
		c, err = smtp.NewClient(rawConn, host)
		if err != nil {
			_ = rawConn.Close()
			return fmt.Errorf("smtp client: %w", err)
		}
		// STARTTLS on 587/25 etc.; on 465 use implicit TLS only
		if s.SMTPTLS {
			if ok, _ := c.Extension("STARTTLS"); ok {
				tlsCfg := &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12}
				if err := c.StartTLS(tlsCfg); err != nil {
					_ = c.Close()
					return fmt.Errorf("starttls: %w", err)
				}
			}
		}
	}
	defer func() { _ = c.Close() }()

	if user != "" || pass != "" {
		auth := smtp.PlainAuth("", user, pass, host)
		if err := c.Auth(auth); err != nil {
			return fmt.Errorf("smtp auth: %w", err)
		}
	}

	return sendMessage(c, from, to, msg)
}

func sendMessage(c *smtp.Client, from string, to []string, msg []byte) error {
	if err := c.Mail(from); err != nil {
		return fmt.Errorf("mail from: %w", err)
	}
	for _, rcpt := range to {
		if err := c.Rcpt(rcpt); err != nil {
			return fmt.Errorf("rcpt %s: %w", rcpt, err)
		}
	}
	w, err := c.Data()
	if err != nil {
		return fmt.Errorf("data: %w", err)
	}
	if _, err := w.Write(msg); err != nil {
		return fmt.Errorf("write body: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("close data: %w", err)
	}
	return c.Quit()
}

func encodeSubject(s string) string {
	// Minimal encoding for non-ASCII in subject (simplified: replace CRLF)
	return strings.ReplaceAll(strings.ReplaceAll(s, "\r", " "), "\n", " ")
}
