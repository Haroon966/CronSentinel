package heartbeat

import "testing"

func TestGenerateToken(t *testing.T) {
	s, err := GenerateToken()
	if err != nil {
		t.Fatal(err)
	}
	if len(s) < 40 {
		t.Fatalf("token too short: %d", len(s))
	}
	s2, err := GenerateToken()
	if err != nil {
		t.Fatal(err)
	}
	if s == s2 {
		t.Fatal("tokens should differ")
	}
}
