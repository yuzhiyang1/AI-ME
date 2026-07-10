package feishu

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

const defaultBaseURL = "https://open.feishu.cn/open-apis"

type Client struct {
	appID     string
	appSecret string
	baseURL   string
	http      *http.Client

	mu          sync.Mutex
	tenantToken string
	tokenExpiry time.Time
}

type Config struct {
	AppID      string
	AppSecret  string
	BaseURL    string
	HTTPClient *http.Client
}

type ReplyResponse struct {
	MessageID string `json:"message_id"`
}

func NewClient(cfg Config) *Client {
	baseURL := strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	if baseURL == "" {
		baseURL = defaultBaseURL
	}
	httpClient := cfg.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 10 * time.Second}
	}
	return &Client{
		appID:     strings.TrimSpace(cfg.AppID),
		appSecret: strings.TrimSpace(cfg.AppSecret),
		baseURL:   baseURL,
		http:      httpClient,
	}
}

func (c *Client) Enabled() bool {
	return c != nil && c.appID != "" && c.appSecret != ""
}

func (c *Client) ReplyText(ctx context.Context, messageID, text, idempotencyKey string) (ReplyResponse, error) {
	if !c.Enabled() {
		return ReplyResponse{}, fmt.Errorf("feishu client is not configured")
	}
	messageID = strings.TrimSpace(messageID)
	if messageID == "" {
		return ReplyResponse{}, fmt.Errorf("message_id is required")
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return ReplyResponse{}, fmt.Errorf("text is required")
	}

	content, err := json.Marshal(map[string]string{"text": text})
	if err != nil {
		return ReplyResponse{}, err
	}
	body := map[string]string{
		"msg_type": "text",
		"content":  string(content),
	}
	idempotencyKey = strings.TrimSpace(idempotencyKey)
	if len(idempotencyKey) > 50 {
		return ReplyResponse{}, fmt.Errorf("feishu idempotency key exceeds 50 characters")
	}
	if idempotencyKey != "" {
		body["uuid"] = idempotencyKey
	}
	var resp struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
		Data struct {
			MessageID string `json:"message_id"`
		} `json:"data"`
	}
	if err := c.doTenantRequest(ctx, http.MethodPost, "/im/v1/messages/"+messageID+"/reply", body, &resp); err != nil {
		return ReplyResponse{}, err
	}
	if resp.Code != 0 {
		return ReplyResponse{}, fmt.Errorf("feishu reply failed: code=%d msg=%s", resp.Code, resp.Msg)
	}
	return ReplyResponse{MessageID: resp.Data.MessageID}, nil
}

func (c *Client) doTenantRequest(ctx context.Context, method, path string, body any, out any) error {
	token, err := c.TenantAccessToken(ctx)
	if err != nil {
		return err
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, bytes.NewReader(encoded))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	return c.doJSON(req, out)
}

func (c *Client) TenantAccessToken(ctx context.Context) (string, error) {
	if !c.Enabled() {
		return "", fmt.Errorf("feishu client is not configured")
	}
	c.mu.Lock()
	if c.tenantToken != "" && time.Now().Before(c.tokenExpiry.Add(-2*time.Minute)) {
		token := c.tenantToken
		c.mu.Unlock()
		return token, nil
	}
	c.mu.Unlock()

	body := map[string]string{
		"app_id":     c.appID,
		"app_secret": c.appSecret,
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/auth/v3/tenant_access_token/internal", bytes.NewReader(encoded))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json; charset=utf-8")

	var resp struct {
		Code              int    `json:"code"`
		Msg               string `json:"msg"`
		TenantAccessToken string `json:"tenant_access_token"`
		Expire            int64  `json:"expire"`
	}
	if err := c.doJSON(req, &resp); err != nil {
		return "", err
	}
	if resp.Code != 0 || resp.TenantAccessToken == "" {
		return "", fmt.Errorf("feishu tenant token failed: code=%d msg=%s", resp.Code, resp.Msg)
	}
	expiresIn := time.Duration(resp.Expire) * time.Second
	if expiresIn <= 0 {
		expiresIn = time.Hour
	}

	c.mu.Lock()
	c.tenantToken = resp.TenantAccessToken
	c.tokenExpiry = time.Now().Add(expiresIn)
	c.mu.Unlock()
	return resp.TenantAccessToken, nil
}

func (c *Client) doJSON(req *http.Request, out any) error {
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("feishu http status %d", resp.StatusCode)
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}
