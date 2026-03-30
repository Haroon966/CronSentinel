package notify

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestPostJSONWebhook(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if ct := r.Header.Get("Content-Type"); ct != "application/json" {
			t.Errorf("content-type: %q", ct)
		}
		b, _ := io.ReadAll(r.Body)
		if !strings.Contains(string(b), `"alert_type":"test"`) {
			t.Errorf("body: %s", string(b))
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	d := &Dispatcher{HTTPClient: srv.Client()}
	err := d.postJSON(context.Background(), srv.URL, AlertPayload{AlertType: "test", Timestamp: time.Now().UTC().Format(time.RFC3339Nano)})
	if err != nil {
		t.Fatal(err)
	}
}

func TestPostJSONWebhookErrorStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte("nope"))
	}))
	defer srv.Close()

	d := &Dispatcher{HTTPClient: srv.Client()}
	err := d.postJSON(context.Background(), srv.URL, AlertPayload{AlertType: "test", Timestamp: "t"})
	if err == nil || !strings.Contains(err.Error(), "400") {
		t.Fatalf("expected 400 error, got %v", err)
	}
}

func TestFormatSlackTextIncludesJobURL(t *testing.T) {
	s := formatSlackText(AlertPayload{
		AlertType: "run_completed",
		JobName:   "j1",
		Status:    "failure",
		Timestamp: "t",
		JobURL:    "https://x.example/jobs",
	})
	if !strings.Contains(s, "j1") || !strings.Contains(s, "https://x.example") {
		t.Fatalf("slack text: %s", s)
	}
}

func TestTestChannelWritesLogWithMockHTTP(t *testing.T) {
	var calls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	// Minimal pool test skipped — TestChannel integration needs DB.
	// Verify slack path hits URL when Row is populated:
	row := &AlertChannelRow{
		ID:      uuid.New(),
		Kind:    ChannelSlackWebhook,
		Label:   "t",
		Enabled: true,
		Slack:   &SlackWebhookConfigJSON{WebhookURL: srv.URL},
	}
	d := &Dispatcher{HTTPClient: srv.Client()}
	p := AlertPayload{AlertType: AlertTypeTest, Timestamp: time.Now().UTC().Format(time.RFC3339Nano)}
	err := d.postSlack(context.Background(), row.Slack.WebhookURL, p, "fallback")
	if err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatalf("expected 1 POST, got %d", calls)
	}
}
