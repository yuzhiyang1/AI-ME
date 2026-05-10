package execenv

import "fmt"

// BuildCommentReplyInstructions returns the canonical block telling an agent
// how to post its reply for a comment-triggered task. Both the per-turn
// prompt (daemon.buildCommentPrompt) and the CLAUDE.md workflow
// (InjectRuntimeConfig) call this so the trigger comment ID and the
// --parent value cannot drift between surfaces.
//
// The explicit "do not reuse --parent from previous turns" wording exists
// because resumed Claude sessions keep prior turns' tool calls in context
// and will otherwise copy the old --parent UUID forward.
func BuildCommentReplyInstructions(issueID, triggerCommentID string) string {
	if triggerCommentID == "" {
		return ""
	}
	return fmt.Sprintf(
		"If you decide to reply, post it as a comment — always use the trigger comment ID below, "+
			"do NOT reuse --parent values from previous turns in this session.\n\n"+
			"Always write agent-authored issue comments to a UTF-8 temp file and pass it with `--content-file <path>`, even when the reply is a single line. "+
			"Do NOT use inline `--content` or pipe non-ASCII text into the CLI; PowerShell can convert Chinese/Japanese/etc. to `?` before the CLI receives it.\n\n"+
			"Use this form, preserving the same issue ID and --parent value:\n\n"+
			"    @'\n"+
			"    First paragraph.\n"+
			"\n"+
			"    Second paragraph.\n"+
			"    '@ | Set-Content -LiteralPath .multica-reply.md -Encoding utf8\n"+
			"    multica issue comment add %s --parent %s --content-file .multica-reply.md\n\n"+
			"Do NOT write literal `\\n` escapes to simulate line breaks; the UTF-8 file preserves real newlines.\n",
		issueID, triggerCommentID,
	)
}
