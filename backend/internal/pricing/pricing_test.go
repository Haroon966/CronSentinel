package pricing

import (
	"testing"
)

func TestLoadEmbedded(t *testing.T) {
	s, err := LoadEmbedded()
	if err != nil {
		t.Fatal(err)
	}
	if len(s.order) < 1 {
		t.Fatal("expected tiers")
	}
	d := s.DefaultTier()
	if d.Slug == "" || d.MaxMonitors < 1 {
		t.Fatalf("default tier: %+v", d)
	}
	if _, ok := s.TierBySlug("free"); !ok {
		t.Fatal("expected free tier")
	}
}

func TestTierBySlugUnknown(t *testing.T) {
	s, err := LoadEmbedded()
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := s.TierBySlug("nonexistent"); ok {
		t.Fatal("expected unknown")
	}
}
