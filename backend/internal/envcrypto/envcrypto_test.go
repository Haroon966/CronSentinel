package envcrypto

import "testing"

func TestEncryptDecryptRoundTrip(t *testing.T) {
	var key [32]byte
	for i := range key {
		key[i] = byte(i + 1)
	}
	plain := "secret-value-unicode-\u2260"
	ct, err := Encrypt(key, plain)
	if err != nil {
		t.Fatal(err)
	}
	got, err := Decrypt(key, ct)
	if err != nil {
		t.Fatal(err)
	}
	if got != plain {
		t.Fatalf("want %q got %q", plain, got)
	}
}

func TestDecryptWrongKeyFails(t *testing.T) {
	var k1, k2 [32]byte
	k1[0] = 1
	k2[0] = 2
	ct, err := Encrypt(k1, "x")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Decrypt(k2, ct); err == nil {
		t.Fatal("expected decrypt error with wrong key")
	}
}
