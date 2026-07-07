package handler

import "testing"

func TestFeishuOwnerMentionedMatchesAllowedOpenID(t *testing.T) {
	message := feishuMessage{
		MessageType: "text",
		Content:     `{"text":"帮我看一下 @玉旨杨","mentions":[{"name":"玉旨杨","id":{"open_id":"ou_owner","user_id":"u_owner"}}]}`,
	}

	if !feishuOwnerMentioned(message, feishuConfig{AllowedOpenID: "ou_owner"}) {
		t.Fatal("expected owner mention to match allowed open_id")
	}
}

func TestFeishuOwnerMentionedIgnoresUnrelatedMention(t *testing.T) {
	message := feishuMessage{
		MessageType: "text",
		Content:     `{"text":"参会人员 @张三","mentions":[{"name":"张三","id":{"open_id":"ou_other","user_id":"u_other"}}]}`,
	}

	if feishuOwnerMentioned(message, feishuConfig{AllowedOpenID: "ou_owner", OwnerName: "玉旨杨"}) {
		t.Fatal("expected unrelated mention to be ignored")
	}
}

func TestNormalizeFeishuDifyDecisionCreateIssueWithReply(t *testing.T) {
	decision := normalizeFeishuDifyDecision(feishuDifyDecision{
		Action:     feishuDifyActionCreateIssue,
		ReplyText:  "收到，我来处理。",
		Confidence: 2,
	}, "优惠券使用记录在哪张表呀？")

	if !decision.ShouldCreateIssue {
		t.Fatal("expected create_issue action to create an issue")
	}
	if !decision.ShouldReply {
		t.Fatal("expected create_issue with reply text to reply")
	}
	if decision.Confidence != 1 {
		t.Fatalf("confidence = %v, want 1", decision.Confidence)
	}
	if decision.IssueTitle == "" {
		t.Fatal("expected fallback issue title")
	}
}

func TestNormalizeFeishuDifyDecisionIgnoreClearsWork(t *testing.T) {
	decision := normalizeFeishuDifyDecision(feishuDifyDecision{
		Action:            feishuDifyActionIgnore,
		TaskKind:          "sql_draft",
		ShouldCreateIssue: true,
		ShouldReply:       true,
		ReplyText:         "收到",
	}, "吃晚饭吗？")

	if decision.ShouldCreateIssue || decision.ShouldReply || decision.ReplyText != "" || decision.TaskKind != "none" {
		t.Fatalf("ignore decision was not cleared: %+v", decision)
	}
}
