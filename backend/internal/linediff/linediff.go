// Package linediff builds a simple line-oriented unified-style diff for plain text.
package linediff

import (
	"strings"
)

// Unified returns a newline-terminated diff with " " (context), "- " (removed), "+ " (added).
// Lines are compared exactly after normalizing CRLF to LF.
func Unified(oldText, newText string) string {
	a := splitLines(oldText)
	b := splitLines(newText)
	if len(a) == 0 && len(b) == 0 {
		return ""
	}
	n, m := len(a), len(b)
	dp := make([][]int, n+1)
	for i := range dp {
		dp[i] = make([]int, m+1)
	}
	for i := 1; i <= n; i++ {
		for j := 1; j <= m; j++ {
			if a[i-1] == b[j-1] {
				dp[i][j] = dp[i-1][j-1] + 1
			} else if dp[i-1][j] >= dp[i][j-1] {
				dp[i][j] = dp[i-1][j]
			} else {
				dp[i][j] = dp[i][j-1]
			}
		}
	}
	type op struct {
		kind byte // ' ', '-', '+'
		line string
	}
	var ops []op
	i, j := n, m
	for i > 0 || j > 0 {
		if i > 0 && j > 0 && a[i-1] == b[j-1] {
			ops = append(ops, op{' ', a[i-1]})
			i--
			j--
		} else if j > 0 && (i == 0 || dp[i][j-1] > dp[i-1][j]) {
			ops = append(ops, op{'+', b[j-1]})
			j--
		} else if i > 0 {
			ops = append(ops, op{'-', a[i-1]})
			i--
		} else {
			ops = append(ops, op{'+', b[j-1]})
			j--
		}
	}
	for x, y := 0, len(ops)-1; x < y; x, y = x+1, y-1 {
		ops[x], ops[y] = ops[y], ops[x]
	}
	var out strings.Builder
	for _, o := range ops {
		out.WriteByte(o.kind)
		out.WriteByte(' ')
		out.WriteString(o.line)
		out.WriteByte('\n')
	}
	return out.String()
}

func splitLines(s string) []string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	if s == "" {
		return nil
	}
	return strings.Split(s, "\n")
}
