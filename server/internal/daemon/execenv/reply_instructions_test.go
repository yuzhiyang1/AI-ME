package execenv

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBuildCommentReplyInstructionsIncludesTriggerID(t *testing.T) {
	t.Parallel()

	issueID := "11111111-1111-1111-1111-111111111111"
	triggerID := "22222222-2222-2222-2222-222222222222"

	got := BuildCommentReplyInstructions(issueID, triggerID)

	for _, want := range []string{
		"multica issue comment add " + issueID + " --parent " + triggerID,
		"Always write agent-authored issue comments to a UTF-8 temp file",
		"even when the reply is a single line",
		"--content-file",
		"Set-Content",
		"Do NOT write literal `\\n` escapes to simulate line breaks",
		"do NOT reuse --parent values from previous turns",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("reply instructions missing %q\n---\n%s", want, got)
		}
	}

	if strings.Contains(got, "--content \"...\"") {
		t.Fatalf("reply instructions should not offer inline --content form\n---\n%s", got)
	}
	if strings.Contains(got, "--content-stdin") {
		t.Fatalf("reply instructions should not offer stdin for comment bodies on Windows\n---\n%s", got)
	}
}

func TestBuildCommentReplyInstructionsEmptyWhenNoTrigger(t *testing.T) {
	t.Parallel()

	if got := BuildCommentReplyInstructions("issue-id", ""); got != "" {
		t.Fatalf("expected empty string when triggerCommentID is empty, got %q", got)
	}
}

func TestInjectRuntimeConfigCommentTriggerUsesHelper(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()

	issueID := "11111111-1111-1111-1111-111111111111"
	triggerID := "22222222-2222-2222-2222-222222222222"

	ctx := TaskContextForEnv{
		IssueID:          issueID,
		TriggerCommentID: triggerID,
	}
	if err := InjectRuntimeConfig(dir, "claude", ctx); err != nil {
		t.Fatalf("InjectRuntimeConfig failed: %v", err)
	}

	content, err := os.ReadFile(filepath.Join(dir, "CLAUDE.md"))
	if err != nil {
		t.Fatalf("read CLAUDE.md: %v", err)
	}

	s := string(content)
	for _, want := range []string{
		triggerID,
		"multica issue comment add " + issueID + " --parent " + triggerID,
		"do NOT reuse --parent values from previous turns",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("CLAUDE.md missing %q", want)
		}
	}
}
