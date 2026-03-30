package main

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestEncodeDecodeTimeIDCursor(t *testing.T) {
	id := uuid.MustParse("11111111-1111-1111-1111-111111111111")
	ts := time.Date(2026, 3, 30, 12, 0, 0, 0, time.UTC)
	s := encodeTimeIDCursor(ts, id)
	c, err := decodeTimeIDCursor(s)
	if err != nil {
		t.Fatal(err)
	}
	if !c.T.Equal(ts.UTC()) {
		t.Fatalf("time: want %v got %v", ts.UTC(), c.T)
	}
	if c.ID != id {
		t.Fatalf("id: want %v got %v", id, c.ID)
	}
}
