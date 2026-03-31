package main

import (
	"testing"
)

func TestComputePercentileEmpty(t *testing.T) {
	if got := computePercentile(nil, 50); got != 0 {
		t.Fatalf("empty slice: want 0, got %d", got)
	}
	if got := computePercentile([]int64{}, 95); got != 0 {
		t.Fatalf("empty slice: want 0, got %d", got)
	}
}

func TestComputePercentileSingleValue(t *testing.T) {
	s := []int64{42}
	for _, p := range []float64{1, 50, 95, 99, 100} {
		if got := computePercentile(s, p); got != 42 {
			t.Fatalf("single value p%.0f: want 42, got %d", p, got)
		}
	}
}

func TestComputePercentileP50OddLength(t *testing.T) {
	// sorted: [1,2,3,4,5] — nearest-rank p50: ceil(0.5*5)=3 → index 2 → 3
	s := []int64{1, 2, 3, 4, 5}
	if got := computePercentile(s, 50); got != 3 {
		t.Fatalf("p50 odd: want 3, got %d", got)
	}
}

func TestComputePercentileP50EvenLength(t *testing.T) {
	// sorted: [1,2,3,4] — nearest-rank p50: ceil(0.5*4)=2 → index 1 → 2
	s := []int64{1, 2, 3, 4}
	if got := computePercentile(s, 50); got != 2 {
		t.Fatalf("p50 even: want 2, got %d", got)
	}
}

func TestComputePercentileP95(t *testing.T) {
	// sorted: 100 values 1..100 — nearest-rank p95: ceil(0.95*100)=95 → index 94 → 95
	s := make([]int64, 100)
	for i := range s {
		s[i] = int64(i + 1)
	}
	if got := computePercentile(s, 95); got != 95 {
		t.Fatalf("p95 1..100: want 95, got %d", got)
	}
}

func TestComputePercentileP99(t *testing.T) {
	// sorted: 100 values 1..100 — nearest-rank p99: ceil(0.99*100)=99 → index 98 → 99
	s := make([]int64, 100)
	for i := range s {
		s[i] = int64(i + 1)
	}
	if got := computePercentile(s, 99); got != 99 {
		t.Fatalf("p99 1..100: want 99, got %d", got)
	}
}

func TestComputePercentileAllSameValue(t *testing.T) {
	s := []int64{500, 500, 500, 500, 500}
	for _, p := range []float64{50, 95, 99} {
		if got := computePercentile(s, p); got != 500 {
			t.Fatalf("all-same p%.0f: want 500, got %d", p, got)
		}
	}
}

func TestComputePercentileTwoValues(t *testing.T) {
	// [100, 200]: p50 → ceil(0.5*2)=1 → index 0 → 100; p95 → ceil(0.95*2)=2 → index 1 → 200
	s := []int64{100, 200}
	if got := computePercentile(s, 50); got != 100 {
		t.Fatalf("p50 two: want 100, got %d", got)
	}
	if got := computePercentile(s, 95); got != 200 {
		t.Fatalf("p95 two: want 200, got %d", got)
	}
}

func TestComputePercentileP100(t *testing.T) {
	s := []int64{10, 20, 30}
	if got := computePercentile(s, 100); got != 30 {
		t.Fatalf("p100: want 30, got %d", got)
	}
}
