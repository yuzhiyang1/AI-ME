package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/middleware"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type fakeAIMeModelClient struct {
	content    string
	onComplete func(systemPrompt, userPrompt string)
}

func (f fakeAIMeModelClient) Configured() bool { return true }
func (f fakeAIMeModelClient) Provider() string { return "fake" }
func (f fakeAIMeModelClient) Model() string    { return "fake-model" }
func (f fakeAIMeModelClient) Complete(_ context.Context, systemPrompt, userPrompt string) (string, error) {
	if f.onComplete != nil {
		f.onComplete(systemPrompt, userPrompt)
	}
	return f.content, nil
}

func TestParseAIMeDecisionExtractsJSONFromMarkdown(t *testing.T) {
	raw := "```json\n{\"summary\":\"需要拆任务\",\"risk_level\":\"high\",\"confidence\":0.82,\"need_approval\":true,\"actions\":[{\"type\":\"assign_worker\",\"title\":\"交给 Codex\",\"description\":\"让 Codex 先检查代码\",\"priority\":\"urgent\",\"requires_approval\":true}],\"evidence\":[{\"type\":\"user_input\",\"label\":\"用户输入\",\"quote\":\"帮我修\"}]}\n```"

	got, ok := parseAIMeDecision(raw)
	if !ok {
		t.Fatal("expected parse success")
	}
	if got.Summary != "需要拆任务" {
		t.Fatalf("summary = %q", got.Summary)
	}
	if got.RiskLevel != "high" {
		t.Fatalf("risk = %q", got.RiskLevel)
	}
	if got.Confidence != 0.82 {
		t.Fatalf("confidence = %v", got.Confidence)
	}
	if len(got.Actions) != 1 || got.Actions[0].Type != "assign_worker" {
		t.Fatalf("actions = %#v", got.Actions)
	}
}

func TestParseAIMeDecisionNormalizesUnsafeValues(t *testing.T) {
	raw := `{"summary":"ok","risk_level":"unknown","confidence":2,"actions":[{"type":"invent_worker","title":"","description":"","priority":"later"}]}`

	got, ok := parseAIMeDecision(raw)
	if !ok {
		t.Fatal("expected parse success")
	}
	if got.RiskLevel != "medium" {
		t.Fatalf("risk = %q", got.RiskLevel)
	}
	if got.Confidence != 1 {
		t.Fatalf("confidence = %v", got.Confidence)
	}
	if got.Actions[0].Type != "ask_user" {
		t.Fatalf("action type = %q", got.Actions[0].Type)
	}
	if got.Actions[0].Priority != "medium" {
		t.Fatalf("priority = %q", got.Actions[0].Priority)
	}
}

func TestBuildAIMeApprovalRequestCreatesIssueCommentApproval(t *testing.T) {
	issueID := "11111111-1111-1111-1111-111111111111"
	req := AIMeThinkRequest{
		Input:       "帮我回复这个退款问题",
		SourceType:  "issue",
		SourceRefID: issueID,
	}
	resp := AIMeThinkResponse{
		ID:               "think-1",
		Summary:          "建议先解释处理进度。",
		RiskLevel:        "high",
		Confidence:       0.91,
		NeedApproval:     true,
		ReplyDraft:       "您好，我们已经在处理退款，请再给我们一点时间。",
		ReasoningSummary: "退款回复对外可见，需要审批。",
		Actions: []AIMeSuggestedAction{{
			Type:             "draft_reply",
			Title:            "回复用户退款进度",
			Description:      "使用草稿回复用户。",
			RequiresApproval: true,
		}},
	}

	got, ok := buildAIMeApprovalRequest(req, resp)
	if !ok {
		t.Fatal("expected approval request")
	}
	if got.ActionType != "post_internal_comment" {
		t.Fatalf("action type = %q", got.ActionType)
	}
	if got.IssueID != issueID {
		t.Fatalf("issue id = %q", got.IssueID)
	}
	payload, ok := got.FinalPayload.(map[string]any)
	if !ok {
		t.Fatalf("payload type = %T", got.FinalPayload)
	}
	if payload["content"] != resp.ReplyDraft {
		t.Fatalf("content = %#v", payload["content"])
	}
	if len(got.Evidence) < 2 {
		t.Fatalf("evidence = %#v", got.Evidence)
	}
}

func TestBuildAIMeApprovalRequestKeepsManualReplyAsDraftApproval(t *testing.T) {
	req := AIMeThinkRequest{Input: "帮我写一段说明"}
	resp := AIMeThinkResponse{
		ID:           "think-2",
		Summary:      "生成说明草稿。",
		RiskLevel:    "low",
		Confidence:   0.72,
		NeedApproval: true,
		ReplyDraft:   "这是给团队看的说明草稿。",
	}

	got, ok := buildAIMeApprovalRequest(req, resp)
	if !ok {
		t.Fatal("expected approval request")
	}
	if got.ActionType != "draft_reply" {
		t.Fatalf("action type = %q", got.ActionType)
	}
	if got.IssueID != "" {
		t.Fatalf("issue id = %q", got.IssueID)
	}
}

func TestBuildAIMeApprovalRequestSkipsAskUserOnly(t *testing.T) {
	req := AIMeThinkRequest{Input: "信息不够怎么办"}
	resp := AIMeThinkResponse{
		Summary:      "需要补充信息。",
		NeedApproval: true,
		Actions: []AIMeSuggestedAction{{
			Type:             "ask_user",
			Title:            "询问用户",
			Description:      "请补充更多上下文。",
			RequiresApproval: true,
		}},
	}

	if got, ok := buildAIMeApprovalRequest(req, resp); ok {
		t.Fatalf("expected no approval request, got %#v", got)
	}
}

func TestBuildAIMeApprovalRequestDowngradesNeverMemoryExternalReply(t *testing.T) {
	memoryID := "22222222-2222-2222-2222-222222222222"
	req := AIMeThinkRequest{
		Input:       "帮我回复外部消息",
		SourceType:  "feishu",
		SourceRefID: "om_test_message",
	}
	resp := AIMeThinkResponse{
		ID:           "think-never-memory",
		Summary:      "生成回复草稿。",
		RiskLevel:    "high",
		Confidence:   0.8,
		NeedApproval: true,
		ReplyDraft:   "这是一段需要人工检查的回复。",
		Actions: []AIMeSuggestedAction{{
			Type:             "send_external_message",
			Title:            "发送飞书回复",
			Description:      "批准后回复外部消息。",
			RequiresApproval: true,
		}},
		Evidence: []AIMeEvidence{{
			Type:  "memory",
			Label: "不可外发记忆",
			RefID: memoryID,
		}},
		Context: AIMeContextSummary{
			Memories: []AIMeMemoryContext{{
				ID:                memoryID,
				Title:             "不可外发记忆",
				Content:           "只能辅助判断，不能进入外部回复。",
				ExternalUsePolicy: "never",
			}},
		},
	}

	got, ok := buildAIMeApprovalRequest(req, resp)
	if !ok {
		t.Fatal("expected draft approval request")
	}
	if got.ActionType != "draft_reply" {
		t.Fatalf("action type = %q, want draft_reply", got.ActionType)
	}
	payload, ok := got.FinalPayload.(map[string]any)
	if !ok {
		t.Fatalf("payload type = %T", got.FinalPayload)
	}
	if payload["text"] != nil {
		t.Fatalf("draft payload should not include executable send text: %#v", payload)
	}
}

func TestThinkAIMeCreatesApprovalFromLLMDecision(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	w := httptest.NewRecorder()
	createReq := newRequest("POST", "/api/issues?workspace_id="+testWorkspaceID, map[string]any{
		"title":    "AI-Me approval integration test",
		"status":   "todo",
		"priority": "medium",
	})
	testHandler.CreateIssue(w, createReq)
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateIssue: expected 201, got %d: %s", w.Code, w.Body.String())
	}
	var issue IssueResponse
	if err := json.NewDecoder(w.Body).Decode(&issue); err != nil {
		t.Fatalf("decode issue: %v", err)
	}
	t.Cleanup(func() {
		_, _ = testPool.Exec(ctx, `DELETE FROM ai_me_approval WHERE issue_id = $1`, issue.ID)
		_, _ = testPool.Exec(ctx, `DELETE FROM issue WHERE id = $1`, issue.ID)
	})

	origModel := testHandler.AIModel
	testHandler.AIModel = fakeAIMeModelClient{content: `{
		"summary":"需要回复退款进度",
		"risk_level":"high",
		"confidence":0.88,
		"need_approval":true,
		"reply_draft":"您好，我们已经收到退款问题，正在核查处理。",
		"reasoning_summary":"退款相关回复需要人工确认后再发送。",
		"actions":[{"type":"draft_reply","title":"回复退款进度","description":"确认后写入内部评论","issue_id":"` + issue.ID + `","requires_approval":true}],
		"evidence":[{"type":"issue","label":"测试 issue","ref_id":"` + issue.ID + `"}]
	}`}
	t.Cleanup(func() { testHandler.AIModel = origModel })

	member, err := testHandler.getWorkspaceMember(ctx, testUserID, testWorkspaceID)
	if err != nil {
		t.Fatalf("load member: %v", err)
	}
	thinkReq := newRequest("POST", "/api/ai-me/think?workspace_id="+testWorkspaceID, AIMeThinkRequest{
		Input:       "请帮我回复退款进度",
		Intent:      "reply",
		SourceType:  "issue",
		SourceRefID: issue.ID,
		IssueID:     issue.ID,
	})
	thinkReq = thinkReq.WithContext(middleware.SetMemberContext(thinkReq.Context(), testWorkspaceID, member))

	w = httptest.NewRecorder()
	testHandler.ThinkAIMe(w, thinkReq)
	if w.Code != http.StatusOK {
		t.Fatalf("ThinkAIMe: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp AIMeThinkResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.ApprovalID == "" {
		t.Fatalf("expected approval_id, got %#v", resp)
	}
	if resp.Context.Memories == nil {
		t.Fatal("expected memories context to be an empty array, got nil")
	}
	approval, err := testHandler.Queries.GetAIApprovalInWorkspace(ctx, db.GetAIApprovalInWorkspaceParams{
		ID:          parseUUID(resp.ApprovalID),
		WorkspaceID: parseUUID(testWorkspaceID),
	})
	if err != nil {
		t.Fatalf("load approval: %v", err)
	}
	if approval.ActionType != "post_internal_comment" {
		t.Fatalf("action type = %q", approval.ActionType)
	}
	if !approval.IssueID.Valid || uuidToString(approval.IssueID) != issue.ID {
		t.Fatalf("approval issue id = %#v", approval.IssueID)
	}
}

func TestCreateAIMeApprovalCreatesInboxItemForExternalReply(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	confidence, err := numericFromFloat64(0.91)
	if err != nil {
		t.Fatalf("confidence: %v", err)
	}
	payload := map[string]any{
		"channel":    "feishu",
		"message_id": "om_ai_me_inbox_test",
		"chat_id":    "oc_ai_me_inbox_test",
		"text":       "您好，退款问题我已经收到，会继续跟进处理。",
	}
	approval, err := testHandler.createAIMeApproval(ctx, testWorkspaceID, testUserID, db.CreateAIApprovalParams{
		WorkspaceID:        parseUUID(testWorkspaceID),
		RequesterUserID:    parseUUID(testUserID),
		SourceType:         "feishu",
		SourceRefID:        optionalTextFromString("om_ai_me_inbox_test"),
		Title:              "AI-Me 外部回复待审批",
		Summary:            "AI-Me 已生成飞书回复草稿，等待人工审批。",
		RiskLevel:          "high",
		Confidence:         confidence,
		Reversibility:      "irreversible",
		ActionType:         "send_external_message",
		ActionTitle:        "发送飞书回复",
		ActionDescription:  "批准后将回复发送到飞书原消息。",
		OriginalPayload:    jsonBytesOrObject(payload),
		FinalPayload:       jsonBytesOrObject(payload),
		AiReasoningSummary: "外部可见回复需要人工确认。",
	}, []CreateAIApprovalEvidenceRequest{{
		EvidenceType: "feishu",
		Label:        "飞书原消息",
		RefID:        "om_ai_me_inbox_test",
		Quote:        "用户询问退款状态。",
	}})
	if err != nil {
		t.Fatalf("createAIMeApproval: %v", err)
	}
	approvalID := uuidToString(approval.ID)
	t.Cleanup(func() {
		_, _ = testPool.Exec(ctx, `DELETE FROM inbox_item WHERE details->>'approval_id' = $1`, approvalID)
		_, _ = testPool.Exec(ctx, `DELETE FROM ai_me_approval WHERE id = $1`, approvalID)
	})

	var itemCount int
	if err := testPool.QueryRow(ctx, `
		SELECT count(*)
		FROM inbox_item
		WHERE details->>'approval_id' = $1
	`, approvalID).Scan(&itemCount); err != nil {
		t.Fatalf("count approval inbox item: %v", err)
	}
	if itemCount != 1 {
		t.Fatalf("approval inbox item count = %d, want 1", itemCount)
	}

	var itemID, recipientID, itemType, severity, title, body string
	var read, archived bool
	var detailsRaw []byte
	if err := testPool.QueryRow(ctx, `
		SELECT id::text, recipient_id::text, type, severity, title, COALESCE(body, ''), read, archived, details
		FROM inbox_item
		WHERE details->>'approval_id' = $1
	`, approvalID).Scan(&itemID, &recipientID, &itemType, &severity, &title, &body, &read, &archived, &detailsRaw); err != nil {
		t.Fatalf("load approval inbox item: %v", err)
	}
	if itemID == "" {
		t.Fatal("expected inbox item id")
	}
	if !approval.InboxItemID.Valid || uuidToString(approval.InboxItemID) != itemID {
		t.Fatalf("approval inbox_item_id = %#v, want %s", approval.InboxItemID, itemID)
	}
	if recipientID != testUserID {
		t.Fatalf("recipient id = %q, want %q", recipientID, testUserID)
	}
	if itemType != "review_requested" || severity != "action_required" {
		t.Fatalf("inbox item type/severity = %s/%s", itemType, severity)
	}
	if title != "发送飞书回复" {
		t.Fatalf("title = %q", title)
	}
	if !strings.Contains(body, "批准后") {
		t.Fatalf("body = %q", body)
	}
	if read || archived {
		t.Fatalf("read/archived = %v/%v, want false/false", read, archived)
	}
	var details map[string]any
	if err := json.Unmarshal(detailsRaw, &details); err != nil {
		t.Fatalf("decode details: %v", err)
	}
	if details["approval_id"] != approvalID || details["action_type"] != "send_external_message" || details["source_type"] != "feishu" {
		t.Fatalf("details = %#v", details)
	}
	if details["channel"] != "feishu" || details["message_id"] != "om_ai_me_inbox_test" || details["chat_id"] != "oc_ai_me_inbox_test" {
		t.Fatalf("details = %#v", details)
	}
	if details["reply_preview"] == "" {
		t.Fatalf("missing reply preview: %#v", details)
	}

	var linkedInboxID string
	if err := testPool.QueryRow(ctx, `
		SELECT inbox_item_id::text
		FROM ai_me_approval
		WHERE id = $1
	`, approvalID).Scan(&linkedInboxID); err != nil {
		t.Fatalf("load linked approval inbox id: %v", err)
	}
	if linkedInboxID != itemID {
		t.Fatalf("persisted inbox_item_id = %q, want %q", linkedInboxID, itemID)
	}
}

func TestAIApprovalResolutionArchivesLinkedInboxItem(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	confidence, err := numericFromFloat64(0.86)
	if err != nil {
		t.Fatalf("confidence: %v", err)
	}
	payload := map[string]any{
		"channel":    "feishu",
		"message_id": "om_ai_me_resolution_test",
		"text":       "您好，这条回复需要确认后发送。",
	}
	approval, err := testHandler.createAIMeApproval(ctx, testWorkspaceID, testUserID, db.CreateAIApprovalParams{
		WorkspaceID:        parseUUID(testWorkspaceID),
		RequesterUserID:    parseUUID(testUserID),
		SourceType:         "feishu",
		SourceRefID:        optionalTextFromString("om_ai_me_resolution_test"),
		Title:              "是否发送飞书回复",
		Summary:            "AI-Me 已生成外部回复草稿。",
		RiskLevel:          "high",
		Confidence:         confidence,
		Reversibility:      "irreversible",
		ActionType:         "send_external_message",
		ActionTitle:        "发送飞书回复",
		ActionDescription:  "批准后将回复发送到飞书原消息。",
		OriginalPayload:    jsonBytesOrObject(payload),
		FinalPayload:       jsonBytesOrObject(payload),
		AiReasoningSummary: "外部可见回复需要人工确认。",
	}, nil)
	if err != nil {
		t.Fatalf("createAIMeApproval: %v", err)
	}
	approvalID := uuidToString(approval.ID)
	t.Cleanup(func() {
		_, _ = testPool.Exec(ctx, `DELETE FROM inbox_item WHERE details->>'approval_id' = $1`, approvalID)
		_, _ = testPool.Exec(ctx, `DELETE FROM ai_me_approval WHERE id = $1`, approvalID)
	})

	assertInboxArchived := func(want bool) {
		t.Helper()
		var archived bool
		if err := testPool.QueryRow(ctx, `
			SELECT archived
			FROM inbox_item
			WHERE details->>'approval_id' = $1
		`, approvalID).Scan(&archived); err != nil {
			t.Fatalf("load linked inbox archived flag: %v", err)
		}
		if archived != want {
			t.Fatalf("linked inbox archived = %v, want %v", archived, want)
		}
	}
	assertInboxArchived(false)

	observeReq := withURLParam(
		newRequest("POST", "/api/ai-me/approvals/"+approvalID+"/observe?workspace_id="+testWorkspaceID, AIApprovalTransitionRequest{Note: "继续观察"}),
		"id",
		approvalID,
	)
	w := httptest.NewRecorder()
	testHandler.ObserveAIApproval(w, observeReq)
	if w.Code != http.StatusOK {
		t.Fatalf("ObserveAIApproval: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	assertInboxArchived(false)

	rejectReq := withURLParam(
		newRequest("POST", "/api/ai-me/approvals/"+approvalID+"/reject?workspace_id="+testWorkspaceID, AIApprovalTransitionRequest{Reason: "不需要发送"}),
		"id",
		approvalID,
	)
	w = httptest.NewRecorder()
	testHandler.RejectAIApproval(w, rejectReq)
	if w.Code != http.StatusOK {
		t.Fatalf("RejectAIApproval: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	assertInboxArchived(true)
}

func TestThinkAIMeInjectsAllowedMemoriesAndRecordsUsage(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	var allowedMemoryID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO memory_entry (
			workspace_id, owner_user_id, type, category, title, content, summary,
			status, confidence, sensitivity, scope_type, external_use_policy,
			source_mode, created_by_type, created_by_id
		) VALUES (
			$1, $2, 'rule', 'support', '退款回复规则', '对外退款回复需要先确认订单状态。',
			'退款回复要先查订单', 'active', 0.91, 'normal', 'workspace', 'with_approval',
			'manual', 'member', $2
		)
		RETURNING id
	`, testWorkspaceID, testUserID).Scan(&allowedMemoryID); err != nil {
		t.Fatalf("insert allowed memory: %v", err)
	}
	var restrictedMemoryID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO memory_entry (
			workspace_id, owner_user_id, type, title, content, status, confidence,
			sensitivity, scope_type, external_use_policy, source_mode, created_by_type, created_by_id
		) VALUES (
			$1, $2, 'rule', '内部敏感规则', '这条 restricted 记忆不能进入 AI-Me 上下文。',
			'active', 0.9, 'restricted', 'workspace', 'never', 'manual', 'member', $2
		)
		RETURNING id
	`, testWorkspaceID, testUserID).Scan(&restrictedMemoryID); err != nil {
		t.Fatalf("insert restricted memory: %v", err)
	}
	var expiredMemoryID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO memory_entry (
			workspace_id, owner_user_id, type, title, content, status, confidence,
			sensitivity, scope_type, external_use_policy, source_mode, created_by_type, created_by_id, expires_at
		) VALUES (
			$1, $2, 'rule', '过期规则', '这条过期记忆不能进入 AI-Me 上下文。',
			'active', 0.8, 'normal', 'workspace', 'allowed', 'manual', 'member', $2, now() - interval '1 hour'
		)
		RETURNING id
	`, testWorkspaceID, testUserID).Scan(&expiredMemoryID); err != nil {
		t.Fatalf("insert expired memory: %v", err)
	}
	t.Cleanup(func() {
		_, _ = testPool.Exec(ctx, `DELETE FROM memory_usage WHERE memory_id IN ($1, $2, $3)`, allowedMemoryID, restrictedMemoryID, expiredMemoryID)
		_, _ = testPool.Exec(ctx, `DELETE FROM memory_entry WHERE id IN ($1, $2, $3)`, allowedMemoryID, restrictedMemoryID, expiredMemoryID)
	})

	var capturedUserPrompt string
	origModel := testHandler.AIModel
	testHandler.AIModel = fakeAIMeModelClient{
		content: `{
			"summary":"需要先核查订单状态",
			"risk_level":"medium",
			"confidence":0.82,
			"need_approval":false,
			"reasoning_summary":"根据长期记忆，退款回复前要先确认订单状态。",
			"actions":[{"type":"no_action","title":"暂不执行","description":"先人工确认信息","requires_approval":false}],
			"evidence":[{"type":"memory","label":"退款回复规则","ref_id":"` + allowedMemoryID + `"}]
		}`,
		onComplete: func(_ string, userPrompt string) {
			capturedUserPrompt = userPrompt
		},
	}
	t.Cleanup(func() { testHandler.AIModel = origModel })

	member, err := testHandler.getWorkspaceMember(ctx, testUserID, testWorkspaceID)
	if err != nil {
		t.Fatalf("load member: %v", err)
	}
	thinkReq := newRequest("POST", "/api/ai-me/think?workspace_id="+testWorkspaceID, AIMeThinkRequest{
		Input:      "客户问退款进度，应该怎么回复？",
		Intent:     "reply",
		SourceType: "manual",
	})
	thinkReq = thinkReq.WithContext(middleware.SetMemberContext(thinkReq.Context(), testWorkspaceID, member))

	w := httptest.NewRecorder()
	testHandler.ThinkAIMe(w, thinkReq)
	if w.Code != http.StatusOK {
		t.Fatalf("ThinkAIMe: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(capturedUserPrompt, "退款回复规则") || !strings.Contains(capturedUserPrompt, "with_approval") {
		t.Fatalf("allowed memory was not injected into prompt: %s", capturedUserPrompt)
	}
	if strings.Contains(capturedUserPrompt, "内部敏感规则") || strings.Contains(capturedUserPrompt, "过期规则") {
		t.Fatalf("disallowed memory leaked into prompt: %s", capturedUserPrompt)
	}
	var usageCount int
	if err := testPool.QueryRow(ctx, `
		SELECT count(*)
		FROM memory_usage
		WHERE memory_id = $1
		  AND workspace_id = $2
		  AND used_by_type = 'ai_me'
		  AND action = 'ai_me_think'
	`, allowedMemoryID, testWorkspaceID).Scan(&usageCount); err != nil {
		t.Fatalf("count memory usage: %v", err)
	}
	if usageCount != 1 {
		t.Fatalf("memory usage count = %d, want 1", usageCount)
	}
}

func TestGetAIMeCockpitSummaryCountsRealRows(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	member, err := testHandler.getWorkspaceMember(ctx, testUserID, testWorkspaceID)
	if err != nil {
		t.Fatalf("load member: %v", err)
	}

	readSummary := func() AIMeCockpitSummaryResponse {
		t.Helper()
		req := newRequest(http.MethodGet, "/api/ai-me/cockpit/summary?workspace_id="+testWorkspaceID, nil)
		req = req.WithContext(middleware.SetMemberContext(req.Context(), testWorkspaceID, member))
		w := httptest.NewRecorder()
		testHandler.GetAIMeCockpitSummary(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("GetAIMeCockpitSummary: expected 200, got %d: %s", w.Code, w.Body.String())
		}
		var resp AIMeCockpitSummaryResponse
		if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
			t.Fatalf("decode summary: %v", err)
		}
		return resp
	}

	before := readSummary()

	w := httptest.NewRecorder()
	createIssueReq := newRequest("POST", "/api/issues?workspace_id="+testWorkspaceID, map[string]any{
		"title":    "AI-Me cockpit summary integration test",
		"status":   "todo",
		"priority": "medium",
	})
	testHandler.CreateIssue(w, createIssueReq)
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateIssue: expected 201, got %d: %s", w.Code, w.Body.String())
	}
	var issue IssueResponse
	if err := json.NewDecoder(w.Body).Decode(&issue); err != nil {
		t.Fatalf("decode issue: %v", err)
	}

	var agentID string
	if err := testPool.QueryRow(ctx, `
		SELECT id FROM agent
		WHERE workspace_id = $1 AND name = 'Handler Test Agent'
		ORDER BY created_at ASC
		LIMIT 1
	`, testWorkspaceID).Scan(&agentID); err != nil {
		t.Fatalf("load handler test agent: %v", err)
	}

	var queuedTaskID, runningTaskID, completedTaskID, failedTaskID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO agent_task_queue (agent_id, issue_id, runtime_id, status, priority, created_at)
		VALUES ($1, $2, $3, 'queued', 1, now())
		RETURNING id
	`, agentID, issue.ID, testRuntimeID).Scan(&queuedTaskID); err != nil {
		t.Fatalf("insert queued task: %v", err)
	}
	if err := testPool.QueryRow(ctx, `
		INSERT INTO agent_task_queue (agent_id, issue_id, runtime_id, status, priority, started_at, created_at)
		VALUES ($1, $2, $3, 'running', 1, now(), now())
		RETURNING id
	`, agentID, issue.ID, testRuntimeID).Scan(&runningTaskID); err != nil {
		t.Fatalf("insert running task: %v", err)
	}
	if err := testPool.QueryRow(ctx, `
		INSERT INTO agent_task_queue (agent_id, issue_id, runtime_id, status, priority, completed_at, created_at)
		VALUES ($1, $2, $3, 'completed', 1, now(), now())
		RETURNING id
	`, agentID, issue.ID, testRuntimeID).Scan(&completedTaskID); err != nil {
		t.Fatalf("insert completed task: %v", err)
	}
	if err := testPool.QueryRow(ctx, `
		INSERT INTO agent_task_queue (agent_id, issue_id, runtime_id, status, priority, completed_at, created_at)
		VALUES ($1, $2, $3, 'failed', 1, now(), now())
		RETURNING id
	`, agentID, issue.ID, testRuntimeID).Scan(&failedTaskID); err != nil {
		t.Fatalf("insert failed task: %v", err)
	}

	var memoryID, inboxID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO memory_entry (
			workspace_id, owner_user_id, type, category, title, content, summary,
			status, confidence, sensitivity, scope_type, scope_ref_id,
			external_use_policy, source_mode, created_by_type, created_by_id
		) VALUES (
			$1, $2, 'preference', 'cockpit_summary_test', '统计测试记忆',
			'这条记忆用于 cockpit summary handler test。', '统计测试',
			'active', 0.9, 'normal', 'user', $2,
			'never', 'manual', 'member', $2
		)
		RETURNING id
	`, testWorkspaceID, testUserID).Scan(&memoryID); err != nil {
		t.Fatalf("insert memory: %v", err)
	}
	if _, err := testPool.Exec(ctx, `
		INSERT INTO memory_usage (workspace_id, memory_id, used_by_type, used_by_id, issue_id, action, outcome)
		VALUES ($1, $2, 'ai_me', $3, $4, 'ai_me_think', 'used')
	`, testWorkspaceID, memoryID, testUserID, issue.ID); err != nil {
		t.Fatalf("insert memory usage: %v", err)
	}
	if err := testPool.QueryRow(ctx, `
		INSERT INTO inbox_item (workspace_id, recipient_type, recipient_id, type, severity, issue_id, title, body, read, archived)
		VALUES ($1, 'member', $2, 'ai_me_test', 'attention', $3, 'AI-Me cockpit test inbox', 'test', false, false)
		RETURNING id
	`, testWorkspaceID, testUserID, issue.ID).Scan(&inboxID); err != nil {
		t.Fatalf("insert inbox item: %v", err)
	}

	if _, err := testPool.Exec(ctx, `
		INSERT INTO ai_me_approval (
			workspace_id, requester_user_id, source_type, source_ref_id, issue_id,
			title, summary, status, risk_level, confidence, reversibility,
			action_type, action_title, action_description, original_payload, final_payload,
			ai_reasoning_summary, approved_at, execution_status, created_task_id
		) VALUES
			($1, $2, 'feishu', 'summary-pending', $3, '待发送外部回复', '需要审批', 'pending', 'high', 0.8,
			 'irreversible', 'send_external_message', '发送外部回复', '测试', '{}'::jsonb, '{}'::jsonb, '',
			 NULL, 'not_started', NULL),
			($1, $2, 'manual', 'summary-observing', $3, '等待外部确认', '观察中', 'observing', 'medium', 0.7,
			 'partially_reversible', 'draft_reply', '观察', '测试', '{}'::jsonb, '{}'::jsonb, '',
			 NULL, 'not_started', NULL),
			($1, $2, 'ai_me_think', 'summary-assign', $3, '派工成功', '已成功派工', 'approved', 'medium', 0.9,
			 'partially_reversible', 'assign_worker', '分配员工', '测试', '{}'::jsonb, '{}'::jsonb, '',
			 now(), 'succeeded', $4),
			($1, $2, 'manual', 'summary-failed', $3, '执行失败', '已失败', 'approved', 'low', 0.6,
			 'reversible', 'draft_reply', '失败测试', '测试', '{}'::jsonb, '{}'::jsonb, '',
			 now(), 'failed', NULL),
			($1, $2, 'feishu', 'summary-reply', $3, '外部回复成功', '已发送', 'approved', 'medium', 0.8,
			 'irreversible', 'send_external_message', '发送外部回复', '测试', '{}'::jsonb, '{}'::jsonb, '',
			 now(), 'succeeded', NULL)
	`, testWorkspaceID, testUserID, issue.ID, queuedTaskID); err != nil {
		t.Fatalf("insert approvals: %v", err)
	}

	t.Cleanup(func() {
		_, _ = testPool.Exec(ctx, `DELETE FROM ai_me_approval WHERE issue_id = $1`, issue.ID)
		_, _ = testPool.Exec(ctx, `DELETE FROM inbox_item WHERE id = $1`, inboxID)
		_, _ = testPool.Exec(ctx, `DELETE FROM memory_usage WHERE memory_id = $1`, memoryID)
		_, _ = testPool.Exec(ctx, `DELETE FROM memory_entry WHERE id = $1`, memoryID)
		_, _ = testPool.Exec(ctx, `DELETE FROM agent_task_queue WHERE id IN ($1, $2, $3, $4)`, queuedTaskID, runningTaskID, completedTaskID, failedTaskID)
		_, _ = testPool.Exec(ctx, `DELETE FROM activity_log WHERE issue_id = $1`, issue.ID)
		_, _ = testPool.Exec(ctx, `DELETE FROM issue WHERE id = $1`, issue.ID)
	})

	after := readSummary()
	assertDelta := func(name string, beforeValue, afterValue, wantDelta int64) {
		t.Helper()
		if got := afterValue - beforeValue; got != wantDelta {
			t.Fatalf("%s delta = %d, want %d (before=%d after=%d)", name, got, wantDelta, beforeValue, afterValue)
		}
	}
	assertDelta("active_tasks", before.ActiveTasks, after.ActiveTasks, 2)
	assertDelta("queued_tasks", before.QueuedTasks, after.QueuedTasks, 1)
	assertDelta("running_tasks", before.RunningTasks, after.RunningTasks, 1)
	assertDelta("completed_tasks_today", before.CompletedTasksToday, after.CompletedTasksToday, 1)
	assertDelta("failed_tasks_today", before.FailedTasksToday, after.FailedTasksToday, 1)
	assertDelta("pending_decisions", before.PendingDecisions, after.PendingDecisions, 1)
	assertDelta("high_risk_pending", before.HighRiskPending, after.HighRiskPending, 1)
	assertDelta("waiting_external", before.WaitingExternal, after.WaitingExternal, 1)
	assertDelta("execution_succeeded", before.ExecutionSucceeded, after.ExecutionSucceeded, 2)
	assertDelta("execution_failed", before.ExecutionFailed, after.ExecutionFailed, 1)
	assertDelta("external_reply_pending", before.ExternalReplyPending, after.ExternalReplyPending, 1)
	assertDelta("assign_worker_succeeded", before.AssignWorkerSucceeded, after.AssignWorkerSucceeded, 1)
	assertDelta("external_reply_succeeded", before.ExternalReplySucceeded, after.ExternalReplySucceeded, 1)
	assertDelta("active_memories", before.ActiveMemories, after.ActiveMemories, 1)
	assertDelta("memory_used_today", before.MemoryUsedToday, after.MemoryUsedToday, 1)
	assertDelta("unread_inbox", before.UnreadInbox, after.UnreadInbox, 1)
	assertDelta("active_issues", before.ActiveIssues, after.ActiveIssues, 1)
}

func TestApproveAssignWorkerApprovalAssignsIssueAndQueuesTask(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	w := httptest.NewRecorder()
	createIssueReq := newRequest("POST", "/api/issues?workspace_id="+testWorkspaceID, map[string]any{
		"title":    "AI-Me assign worker integration test",
		"status":   "todo",
		"priority": "high",
	})
	testHandler.CreateIssue(w, createIssueReq)
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateIssue: expected 201, got %d: %s", w.Code, w.Body.String())
	}
	var issue IssueResponse
	if err := json.NewDecoder(w.Body).Decode(&issue); err != nil {
		t.Fatalf("decode issue: %v", err)
	}

	t.Cleanup(func() {
		_, _ = testPool.Exec(ctx, `DELETE FROM ai_me_approval WHERE issue_id = $1`, issue.ID)
		_, _ = testPool.Exec(ctx, `DELETE FROM activity_log WHERE issue_id = $1`, issue.ID)
		_, _ = testPool.Exec(ctx, `DELETE FROM agent_task_queue WHERE issue_id = $1`, issue.ID)
		_, _ = testPool.Exec(ctx, `DELETE FROM issue WHERE id = $1`, issue.ID)
	})

	var agentID string
	if err := testPool.QueryRow(ctx, `
		SELECT id FROM agent
		WHERE workspace_id = $1 AND name = 'Handler Test Agent'
		ORDER BY created_at ASC
		LIMIT 1
	`, testWorkspaceID).Scan(&agentID); err != nil {
		t.Fatalf("load handler test agent: %v", err)
	}

	payload := map[string]any{
		"source":            "ai_me_think",
		"approval_action":   "assign_worker",
		"issue_id":          issue.ID,
		"target_agent_id":   agentID,
		"target_agent_name": "Handler Test Agent",
		"priority":          "urgent",
		"summary":           "请员工处理这个高优先级问题。",
	}
	createApprovalReq := newRequest("POST", "/api/ai-me/approvals?workspace_id="+testWorkspaceID, CreateAIApprovalRequest{
		SourceType:         "ai_me_think",
		SourceRefID:        "think-assign-worker",
		IssueID:            issue.ID,
		Title:              "分配给 Handler Test Agent",
		Summary:            "AI-Me 建议让员工处理。",
		RiskLevel:          "medium",
		Reversibility:      "partially_reversible",
		ActionType:         "assign_worker",
		ActionTitle:        "分配员工",
		ActionDescription:  "批准后把 issue 分配给员工并创建执行任务。",
		OriginalPayload:    payload,
		FinalPayload:       payload,
		AIReasoningSummary: "该问题需要员工执行。",
	})
	w = httptest.NewRecorder()
	testHandler.CreateAIApproval(w, createApprovalReq)
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateAIApproval: expected 201, got %d: %s", w.Code, w.Body.String())
	}
	var approval AIApprovalResponse
	if err := json.NewDecoder(w.Body).Decode(&approval); err != nil {
		t.Fatalf("decode approval: %v", err)
	}

	approveReq := withURLParam(
		newRequest("POST", "/api/ai-me/approvals/"+approval.ID+"/approve?workspace_id="+testWorkspaceID, AIApprovalTransitionRequest{Note: "批准派工"}),
		"id",
		approval.ID,
	)
	w = httptest.NewRecorder()
	testHandler.ApproveAIApproval(w, approveReq)
	if w.Code != http.StatusOK {
		t.Fatalf("ApproveAIApproval: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var approved AIApprovalResponse
	if err := json.NewDecoder(w.Body).Decode(&approved); err != nil {
		t.Fatalf("decode approved approval: %v", err)
	}
	if approved.ExecutionStatus != "succeeded" {
		t.Fatalf("execution status = %q", approved.ExecutionStatus)
	}
	if approved.CreatedTaskID == nil || *approved.CreatedTaskID == "" {
		t.Fatalf("expected created_task_id, got %#v", approved.CreatedTaskID)
	}

	var assigneeType, assigneeID string
	if err := testPool.QueryRow(ctx, `
		SELECT assignee_type, assignee_id
		FROM issue
		WHERE id = $1
	`, issue.ID).Scan(&assigneeType, &assigneeID); err != nil {
		t.Fatalf("load assigned issue: %v", err)
	}
	if assigneeType != "agent" || assigneeID != agentID {
		t.Fatalf("assignee = %s:%s, want agent:%s", assigneeType, assigneeID, agentID)
	}

	var taskAgentID, taskIssueID, taskStatus string
	var taskPriority int
	if err := testPool.QueryRow(ctx, `
		SELECT agent_id, issue_id, status, priority
		FROM agent_task_queue
		WHERE id = $1
	`, *approved.CreatedTaskID).Scan(&taskAgentID, &taskIssueID, &taskStatus, &taskPriority); err != nil {
		t.Fatalf("load queued task: %v", err)
	}
	if taskAgentID != agentID || taskIssueID != issue.ID || taskStatus != "queued" || taskPriority != 4 {
		t.Fatalf("queued task = agent:%s issue:%s status:%s priority:%d", taskAgentID, taskIssueID, taskStatus, taskPriority)
	}

	var activityCount int
	if err := testPool.QueryRow(ctx, `
		SELECT count(*)
		FROM activity_log
		WHERE issue_id = $1
		  AND action = 'assignee_changed'
		  AND details->>'approval_id' = $2
		  AND details->>'to_type' = 'agent'
		  AND details->>'to_id' = $3
	`, issue.ID, approval.ID, agentID).Scan(&activityCount); err != nil {
		t.Fatalf("load assignee activity: %v", err)
	}
	if activityCount != 1 {
		t.Fatalf("assignee_changed activity count = %d", activityCount)
	}
}

func TestNewAIModelClientUsesDeepSeekDefaults(t *testing.T) {
	client := NewAIModelClient(Config{
		AIModelProvider: "deepseek",
		AIModelAPIKey:   "sk-test",
	})

	got, ok := client.(*openAICompatibleAIModelClient)
	if !ok {
		t.Fatalf("client type = %T", client)
	}
	if got.baseURL != deepSeekDefaultBaseURL {
		t.Fatalf("baseURL = %q", got.baseURL)
	}
	if got.model != deepSeekDefaultModel {
		t.Fatalf("model = %q", got.model)
	}
	if !got.Configured() {
		t.Fatal("expected client to be configured")
	}
}

func TestAIModelClientDeepSeekRequestShape(t *testing.T) {
	var gotPath string
	var gotAuth string
	var gotPayload map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		if err := json.NewDecoder(r.Body).Decode(&gotPayload); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"summary\":\"ok\"}"}}]}`))
	}))
	t.Cleanup(server.Close)

	client := NewAIModelClient(Config{
		AIModelProvider: "deepseek",
		AIModelBaseURL:  server.URL,
		AIModelAPIKey:   "sk-test",
	})
	content, err := client.Complete(context.Background(), "system", "user")
	if err != nil {
		t.Fatalf("Complete() error = %v", err)
	}
	if content != `{"summary":"ok"}` {
		t.Fatalf("content = %q", content)
	}
	if gotPath != "/chat/completions" {
		t.Fatalf("path = %q", gotPath)
	}
	if gotAuth != "Bearer sk-test" {
		t.Fatalf("authorization = %q", gotAuth)
	}
	if gotPayload["model"] != deepSeekDefaultModel {
		t.Fatalf("model payload = %#v", gotPayload["model"])
	}
	if gotPayload["response_format"].(map[string]any)["type"] != "json_object" {
		t.Fatalf("response_format = %#v", gotPayload["response_format"])
	}
	if gotPayload["thinking"].(map[string]any)["type"] != "disabled" {
		t.Fatalf("thinking = %#v", gotPayload["thinking"])
	}
}
