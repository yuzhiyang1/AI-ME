package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/feishu"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestExecuteApprovalSendExternalMessageSendsFeishuReply(t *testing.T) {
	var sawReply bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/auth/v3/tenant_access_token/internal":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"code":                0,
				"tenant_access_token": "tenant-token",
				"expire":              3600,
			})
		case "/im/v1/messages/om_test/reply":
			if got := r.Header.Get("Authorization"); got != "Bearer tenant-token" {
				t.Fatalf("Authorization header = %q", got)
			}
			var body struct {
				MsgType string `json:"msg_type"`
				Content string `json:"content"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("decode reply body: %v", err)
			}
			if body.MsgType != "text" || body.Content == "" {
				t.Fatalf("unexpected reply body: %+v", body)
			}
			sawReply = true
			_ = json.NewEncoder(w).Encode(map[string]any{
				"code": 0,
				"data": map[string]string{"message_id": "om_reply"},
			})
		default:
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	h := &Handler{Feishu: feishu.NewClient(feishu.Config{
		AppID:      "app",
		AppSecret:  "secret",
		BaseURL:    server.URL,
		HTTPClient: server.Client(),
	})}
	execution, err := h.executeApprovalSendExternalMessage(
		context.Background(),
		db.AiMeApproval{
			SourceType:  "feishu",
			SourceRefID: pgtype.Text{String: "om_test", Valid: true},
		},
		jsonBytesOrObject(map[string]any{
			"channel": "feishu",
			"text":    "确认收到，我会处理。",
		}),
	)
	if err != nil {
		t.Fatalf("executeApprovalSendExternalMessage returned error: %v", err)
	}
	if execution.Status != "succeeded" {
		t.Fatalf("execution status = %q, want succeeded", execution.Status)
	}
	if !sawReply {
		t.Fatal("expected Feishu reply endpoint to be called")
	}
}

func TestExecuteApprovalSendExternalMessageRejectsUnsupportedChannel(t *testing.T) {
	h := &Handler{}
	_, err := h.executeApprovalSendExternalMessage(
		context.Background(),
		db.AiMeApproval{SourceType: "email"},
		jsonBytesOrObject(map[string]any{
			"channel":    "email",
			"message_id": "msg_1",
			"text":       "hello",
		}),
	)
	if err == nil {
		t.Fatal("expected unsupported channel error")
	}
}
