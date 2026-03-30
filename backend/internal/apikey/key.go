package apikey

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"

	"golang.org/x/crypto/bcrypt"
)

// PrefixLen is the length of the lookup prefix stored in api_keys.key_prefix (must match generated keys).
const PrefixLen = 16

const bcryptCost = 12

// GenerateRaw returns a new secret of the form cs_<64 hex chars> (67 bytes).
func GenerateRaw() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("random: %w", err)
	}
	return "cs_" + hex.EncodeToString(b[:]), nil
}

// Prefix returns the first PrefixLen characters of raw for indexed lookup.
func Prefix(raw string) string {
	if len(raw) < PrefixLen {
		return raw
	}
	return raw[:PrefixLen]
}

// Hash stores bcrypt(secret).
func Hash(raw string) ([]byte, error) {
	return bcrypt.GenerateFromPassword([]byte(raw), bcryptCost)
}

// Verify checks raw against a bcrypt hash.
func Verify(hash []byte, raw string) error {
	return bcrypt.CompareHashAndPassword(hash, []byte(raw))
}
