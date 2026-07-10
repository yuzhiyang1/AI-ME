package handler

import (
	"context"
	"encoding/json"
	"strings"
	"time"
)

const aimeWorkspaceSettingsKey = "ai_me"

type AIMeWorkingHours struct {
	Start string `json:"start"`
	End   string `json:"end"`
}

type AIMeWorkspaceSettings struct {
	Enabled             bool             `json:"enabled"`
	AutonomyLevel       string           `json:"autonomy_level"`
	ApprovalMode        string           `json:"approval_mode"`
	DigestCadence       string           `json:"digest_cadence"`
	Timezone            string           `json:"timezone"`
	WorkingHours        AIMeWorkingHours `json:"working_hours"`
	ModelProvider       string           `json:"model_provider"`
	ModelName           string           `json:"model_name"`
	MemoryRetentionDays int              `json:"memory_retention_days"`
	DataRetentionDays   int              `json:"data_retention_days"`
	UpdatedAt           string           `json:"updated_at,omitempty"`
}

type AIMePolicyContext struct {
	Enabled        bool             `json:"enabled"`
	AutonomyLevel  string           `json:"autonomy_level"`
	ApprovalMode   string           `json:"approval_mode"`
	Timezone       string           `json:"timezone"`
	WorkingHours   AIMeWorkingHours `json:"working_hours"`
	InWorkingHours bool             `json:"in_working_hours"`
	ModelProvider  string           `json:"model_provider"`
	ModelName      string           `json:"model_name"`
}

func defaultAIMeWorkspaceSettings() AIMeWorkspaceSettings {
	return AIMeWorkspaceSettings{
		Enabled:             true,
		AutonomyLevel:       "balanced",
		ApprovalMode:        "risky",
		DigestCadence:       "realtime",
		Timezone:            "Asia/Shanghai",
		WorkingHours:        AIMeWorkingHours{Start: "09:00", End: "18:00"},
		ModelProvider:       "deepseek",
		ModelName:           deepSeekDefaultModel,
		MemoryRetentionDays: 180,
		DataRetentionDays:   365,
	}
}

func aimeWorkspaceSettingsFromJSON(raw []byte) AIMeWorkspaceSettings {
	settings := defaultAIMeWorkspaceSettings()
	if len(raw) == 0 {
		return settings
	}
	var root map[string]any
	if err := json.Unmarshal(raw, &root); err != nil {
		return settings
	}
	rawAIMe, _ := root[aimeWorkspaceSettingsKey].(map[string]any)
	if rawAIMe == nil {
		return settings
	}
	settings.Enabled = pickBool(rawAIMe["enabled"], settings.Enabled)
	settings.AutonomyLevel = pickAIMeEnum(rawAIMe["autonomy_level"], settings.AutonomyLevel, "assistive", "balanced", "autonomous")
	settings.ApprovalMode = pickAIMeEnum(rawAIMe["approval_mode"], settings.ApprovalMode, "always", "risky", "never")
	settings.DigestCadence = pickAIMeEnum(rawAIMe["digest_cadence"], settings.DigestCadence, "realtime", "daily", "muted")
	settings.Timezone = pickNonEmptyString(rawAIMe["timezone"], settings.Timezone)
	if workingHours, ok := rawAIMe["working_hours"].(map[string]any); ok {
		settings.WorkingHours.Start = pickAIMeTime(workingHours["start"], settings.WorkingHours.Start)
		settings.WorkingHours.End = pickAIMeTime(workingHours["end"], settings.WorkingHours.End)
	}
	settings.ModelProvider = pickAIMeEnum(rawAIMe["model_provider"], settings.ModelProvider, "deepseek", "openai", "anthropic", "custom")
	settings.ModelName = pickNonEmptyString(rawAIMe["model_name"], settings.ModelName)
	settings.MemoryRetentionDays = pickPositiveInt(rawAIMe["memory_retention_days"], settings.MemoryRetentionDays)
	settings.DataRetentionDays = pickPositiveInt(rawAIMe["data_retention_days"], settings.DataRetentionDays)
	if updatedAt, ok := rawAIMe["updated_at"].(string); ok {
		settings.UpdatedAt = strings.TrimSpace(updatedAt)
	}
	return settings
}

func buildAIMePolicyContext(settings AIMeWorkspaceSettings, now time.Time) AIMePolicyContext {
	return AIMePolicyContext{
		Enabled:        settings.Enabled,
		AutonomyLevel:  settings.AutonomyLevel,
		ApprovalMode:   settings.ApprovalMode,
		Timezone:       settings.Timezone,
		WorkingHours:   settings.WorkingHours,
		InWorkingHours: aimeWithinWorkingHours(settings, now),
		ModelProvider:  settings.ModelProvider,
		ModelName:      settings.ModelName,
	}
}

func aimeWithinWorkingHours(settings AIMeWorkspaceSettings, now time.Time) bool {
	location, err := time.LoadLocation(settings.Timezone)
	if err != nil {
		location = time.FixedZone("UTC", 0)
	}
	local := now.In(location)
	current := local.Hour()*60 + local.Minute()
	start, okStart := parseAIMeClockMinutes(settings.WorkingHours.Start)
	end, okEnd := parseAIMeClockMinutes(settings.WorkingHours.End)
	if !okStart || !okEnd || start == end {
		return true
	}
	if start < end {
		return current >= start && current < end
	}
	return current >= start || current < end
}

func parseAIMeClockMinutes(value string) (int, bool) {
	parts := strings.Split(strings.TrimSpace(value), ":")
	if len(parts) != 2 {
		return 0, false
	}
	parsed, err := time.Parse("15:04", strings.TrimSpace(value))
	if err != nil {
		return 0, false
	}
	return parsed.Hour()*60 + parsed.Minute(), true
}

func applyAIMeWorkspacePolicy(resp *AIMeThinkResponse, policy AIMePolicyContext) {
	if resp == nil {
		return
	}
	required := false
	for i := range resp.Actions {
		action := &resp.Actions[i]
		if aimeActionRequiresApproval(*resp, *action, policy) {
			action.RequiresApproval = true
		} else if aimePolicyCanClearModelApproval(*resp, policy) {
			action.RequiresApproval = false
		}
		required = required || action.RequiresApproval
	}
	if aimeReplyDraftRequiresApproval(*resp, policy) {
		required = true
	}
	if required {
		resp.NeedApproval = true
		return
	}
	if aimePolicyCanClearModelApproval(*resp, policy) {
		resp.NeedApproval = false
	}
}

func aimeActionRequiresApproval(resp AIMeThinkResponse, action AIMeSuggestedAction, policy AIMePolicyContext) bool {
	actionType := normalizeActionType(action.Type)
	if actionType == "no_action" || actionType == "ask_user" {
		return false
	}
	if aimeHardApprovalAction(actionType) {
		return true
	}
	if !policy.InWorkingHours && aimeDispatchingAction(actionType) {
		return true
	}
	if resp.RiskLevel == "high" {
		return true
	}
	if policy.AutonomyLevel == "assistive" {
		return true
	}
	if policy.ApprovalMode == "always" {
		return true
	}
	return false
}

func aimeReplyDraftRequiresApproval(resp AIMeThinkResponse, policy AIMePolicyContext) bool {
	if strings.TrimSpace(resp.ReplyDraft) == "" {
		return false
	}
	if aimeReplyUsesPolicyGatedMemory(resp, "with_approval", "never") {
		return true
	}
	if resp.RiskLevel == "high" || policy.ApprovalMode == "always" || policy.AutonomyLevel == "assistive" {
		return true
	}
	if !policy.InWorkingHours {
		return true
	}
	return false
}

func aimePolicyCanClearModelApproval(resp AIMeThinkResponse, policy AIMePolicyContext) bool {
	if policy.ApprovalMode != "never" || policy.AutonomyLevel == "assistive" || !policy.InWorkingHours {
		return false
	}
	if resp.RiskLevel == "high" || aimeReplyUsesPolicyGatedMemory(resp, "with_approval", "never") {
		return false
	}
	for _, action := range resp.Actions {
		if aimeHardApprovalAction(normalizeActionType(action.Type)) {
			return false
		}
	}
	return true
}

func aimeHardApprovalAction(actionType string) bool {
	switch actionType {
	case "send_external_message":
		return true
	default:
		return false
	}
}

func aimeDispatchingAction(actionType string) bool {
	switch actionType {
	case "create_task", "assign_worker", "send_external_message", "post_internal_comment":
		return true
	default:
		return false
	}
}

func aimeModelOptionsFromSettings(settings AIMeWorkspaceSettings) AIModelOptions {
	return AIModelOptions{Model: strings.TrimSpace(settings.ModelName)}
}

func aimeModelConfiguredForSettings(client AIModelClient, settings AIMeWorkspaceSettings) bool {
	if client == nil {
		return false
	}
	options := aimeModelOptionsFromSettings(settings)
	if configurable, ok := client.(AIModelClientWithOptions); ok {
		return configurable.ConfiguredWithOptions(options)
	}
	return client.Configured()
}

func completeAIMeModel(ctx context.Context, client AIModelClient, systemPrompt, userPrompt string, settings AIMeWorkspaceSettings) (string, string, error) {
	options := aimeModelOptionsFromSettings(settings)
	if configurable, ok := client.(AIModelClientWithOptions); ok {
		raw, err := configurable.CompleteWithOptions(ctx, systemPrompt, userPrompt, options)
		return raw, configurable.EffectiveModel(options), err
	}
	raw, err := client.Complete(ctx, systemPrompt, userPrompt)
	return raw, client.Model(), err
}

func completeAIMeModelWithUsage(ctx context.Context, client AIModelClient, systemPrompt, userPrompt string, settings AIMeWorkspaceSettings) (AIModelCompletion, string, error) {
	options := aimeModelOptionsFromSettings(settings)
	if metered, ok := client.(AIModelClientWithUsage); ok {
		completion, err := metered.CompleteWithUsage(ctx, systemPrompt, userPrompt, options)
		model := client.Model()
		if configurable, ok := client.(AIModelClientWithOptions); ok {
			model = configurable.EffectiveModel(options)
		}
		return completion, model, err
	}
	raw, model, err := completeAIMeModel(ctx, client, systemPrompt, userPrompt, settings)
	return AIModelCompletion{Content: raw}, model, err
}

func pickBool(value any, fallback bool) bool {
	if parsed, ok := value.(bool); ok {
		return parsed
	}
	return fallback
}

func pickAIMeEnum(value any, fallback string, options ...string) string {
	text, ok := value.(string)
	if !ok {
		return fallback
	}
	text = strings.TrimSpace(text)
	for _, option := range options {
		if text == option {
			return text
		}
	}
	return fallback
}

func pickNonEmptyString(value any, fallback string) string {
	if text, ok := value.(string); ok && strings.TrimSpace(text) != "" {
		return strings.TrimSpace(text)
	}
	return fallback
}

func pickAIMeTime(value any, fallback string) string {
	text, ok := value.(string)
	if !ok {
		return fallback
	}
	if _, ok := parseAIMeClockMinutes(text); !ok {
		return fallback
	}
	return strings.TrimSpace(text)
}

func pickPositiveInt(value any, fallback int) int {
	switch parsed := value.(type) {
	case float64:
		if parsed > 0 && parsed == float64(int(parsed)) {
			return int(parsed)
		}
	case int:
		if parsed > 0 {
			return parsed
		}
	}
	return fallback
}
