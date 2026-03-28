package heartbeat

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
)

// GenerateToken returns a URL-safe random token (32 bytes entropy, base64 URL encoding without padding).
func GenerateToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("rand read: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
