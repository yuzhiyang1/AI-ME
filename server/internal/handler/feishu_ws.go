package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"strings"

	lark "github.com/larksuite/oapi-sdk-go/v3"
	"github.com/larksuite/oapi-sdk-go/v3/channel"
	channeltypes "github.com/larksuite/oapi-sdk-go/v3/channel/types"
	larkcore "github.com/larksuite/oapi-sdk-go/v3/core"
	larkws "github.com/larksuite/oapi-sdk-go/v3/ws"
)

func FeishuWebSocketIntakeEnabled() bool {
	return feishuEventModeFromEnv() == "websocket"
}

func (h *Handler) StartFeishuWebSocketIntake(ctx context.Context) {
	if err := h.runFeishuWebSocketIntake(ctx); err != nil {
		slog.Error("feishu websocket intake stopped", "error", err)
	}
}

func (h *Handler) runFeishuWebSocketIntake(ctx context.Context) error {
	appID := strings.TrimSpace(os.Getenv("FEISHU_APP_ID"))
	appSecret := strings.TrimSpace(os.Getenv("FEISHU_APP_SECRET"))
	if appID == "" || appSecret == "" {
		return fmt.Errorf("FEISHU_APP_ID and FEISHU_APP_SECRET are required for websocket intake")
	}

	apiClient := lark.NewClient(appID, appSecret, lark.WithLogLevel(larkcore.LogLevelInfo))
	wsClient := larkws.NewClient(appID, appSecret, larkws.WithLogLevel(larkcore.LogLevelInfo))
	ch := channel.NewChannel(apiClient, wsClient)
	cfg := feishuConfigFromEnv()
	configureFeishuChannelPolicy(ch, cfg)

	ch.OnReady(func() {
		slog.Info("feishu websocket intake ready")
	})
	ch.OnReconnecting(func() {
		slog.Warn("feishu websocket intake reconnecting")
	})
	ch.OnReconnected(func() {
		slog.Info("feishu websocket intake reconnected")
	})
	ch.OnDisconnected(func() {
		slog.Warn("feishu websocket intake disconnected")
	})
	ch.OnError(func(err error) {
		slog.Warn("feishu websocket intake error", "error", err)
	})
	ch.OnReject(func(ctx context.Context, event *channeltypes.RejectEvent) error {
		slog.Info("feishu websocket message rejected by sdk policy",
			"message_id", event.MessageID,
			"chat_id", event.ChatID,
			"sender_id", event.SenderID,
			"reason", event.Reason,
		)
		return nil
	})
	ch.OnMessage(func(ctx context.Context, msg *channeltypes.NormalizedMessage) error {
		payload := feishuPayloadFromNormalizedMessage(msg)
		_, err := h.ingestFeishuMessage(ctx, payload, cfg, feishuPayloadLogAttrs(payload))
		return err
	})

	slog.Info("starting feishu websocket intake")
	return ch.Start(ctx)
}

func configureFeishuChannelPolicy(ch channeltypes.Channel, cfg feishuConfig) {
	requireMention := false
	policy := channeltypes.PolicyConfig{
		RequireMention: &requireMention,
		DMMode:         "open",
	}
	if cfg.AllowedChatID != "" {
		policy.GroupAllowlist = []string{cfg.AllowedChatID}
	}
	ch.UpdatePolicy(policy)
}

func feishuPayloadFromNormalizedMessage(msg *channeltypes.NormalizedMessage) feishuEventCallback {
	messageType, content := feishuNormalizedMessageContent(msg)
	return feishuEventCallback{
		Type: "im.message.receive_v1",
		Header: feishuHeader{
			EventID:   msg.EventID,
			EventType: "im.message.receive_v1",
		},
		Event: feishuEventBody{
			Sender: feishuSender{
				SenderType: "user",
				SenderID: feishuSenderID{
					UserID: msg.UserID,
				},
			},
			Message: feishuMessage{
				MessageID:   msg.MessageID,
				CreateTime:  fmt.Sprintf("%d", msg.CreateTimeMs),
				ChatID:      msg.ChatID,
				ChatType:    msg.ChatType,
				MessageType: messageType,
				Content:     content,
			},
		},
	}
}

func feishuNormalizedMessageContent(msg *channeltypes.NormalizedMessage) (string, string) {
	messageType := strings.TrimSpace(msg.RawContentType)
	if messageType == "" {
		messageType = "text"
	}
	if messageType != "text" && len(msg.Mentions) == 0 {
		return messageType, strings.TrimSpace(msg.Content)
	}
	content, err := json.Marshal(feishuTextContent{
		Text:     strings.TrimSpace(msg.Content),
		Mentions: feishuMentionsFromNormalizedMessage(msg.Mentions),
	})
	if err != nil {
		return messageType, strings.TrimSpace(msg.Content)
	}
	return "text", string(content)
}

func feishuMentionsFromNormalizedMessage(mentions []channeltypes.Mention) []feishuMention {
	result := make([]feishuMention, 0, len(mentions))
	for _, mention := range mentions {
		result = append(result, feishuMention{
			Key: mention.Key,
			ID: feishuSenderID{
				OpenID: mention.OpenID,
				UserID: mention.UserID,
			},
			Name: mention.Name,
		})
	}
	return result
}
