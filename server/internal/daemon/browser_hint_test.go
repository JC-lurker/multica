package daemon

import (
	"strings"
	"testing"
)

func TestBrowserHintBlock(t *testing.T) {
	if got := buildBrowserHintBlock(Task{IssueID: "iss-1"}); !strings.Contains(got, "multica browser snapshot --issue iss-1") {
		t.Fatalf("issue task missing hint: %q", got)
	}
	if got := buildBrowserHintBlock(Task{ChatSessionID: "c1"}); got != "" {
		t.Fatalf("chat task should have no hint: %q", got)
	}
}
