// Package envcrypto provides AES-256-GCM encryption for per-job environment values at rest.
package envcrypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

const (
	// EnvVarName is the environment variable holding the 32-byte AES key (hex or base64).
	EnvVarName = "CRONSENTINEL_ENV_ENCRYPTION_KEY"
)

// LoadKey returns a 32-byte AES-256 key from CRONSENTINEL_ENV_ENCRYPTION_KEY, or a dev-only
// derived key with predictable bytes when unset (logged by caller).
func LoadKey() (key [32]byte, usingDevFallback bool, err error) {
	raw := strings.TrimSpace(os.Getenv(EnvVarName))
	if raw == "" {
		sum := sha256.Sum256([]byte("cronsentinel-dev-env-encryption-v1"))
		copy(key[:], sum[:])
		return key, true, nil
	}
	if len(raw) == 64 {
		b, derr := hex.DecodeString(raw)
		if derr == nil && len(b) == 32 {
			copy(key[:], b)
			return key, false, nil
		}
	}
	b, derr := base64.StdEncoding.DecodeString(raw)
	if derr != nil {
		return key, false, fmt.Errorf("%s: invalid base64: %w", EnvVarName, derr)
	}
	if len(b) != 32 {
		return key, false, fmt.Errorf("%s: decoded key must be 32 bytes, got %d", EnvVarName, len(b))
	}
	copy(key[:], b)
	return key, false, nil
}

// Encrypt returns nonce || ciphertext (GCM includes auth tag).
func Encrypt(key [32]byte, plaintext string) ([]byte, error) {
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	return gcm.Seal(nonce, nonce, []byte(plaintext), nil), nil
}

// Decrypt reverses Encrypt.
func Decrypt(key [32]byte, blob []byte) (string, error) {
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	ns := gcm.NonceSize()
	if len(blob) < ns {
		return "", errors.New("ciphertext too short")
	}
	nonce, ct := blob[:ns], blob[ns:]
	pt, err := gcm.Open(nil, nonce, ct, nil)
	if err != nil {
		return "", err
	}
	return string(pt), nil
}
