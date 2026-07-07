import type { AIMeThinkIntent, InboxItem } from "@multica/core/types";

function singleLine(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function stripQuickCreatePrefix(title: string, identifier?: string): string {
  const normalized = singleLine(title);
  if (!normalized) return "";

  if (identifier) {
    const exactPrefix = new RegExp(
      `^Created\\s+${escapeRegExp(identifier)}:\\s*`,
      "i",
    );
    const withoutExactPrefix = normalized.replace(exactPrefix, "");
    if (withoutExactPrefix !== normalized) return withoutExactPrefix.trim();
  }

  return normalized.replace(/^Created\s+[A-Z][A-Z0-9]*-\d+:\s*/i, "").trim();
}

export function getInboxDisplayTitle(item: InboxItem): string {
  const details = item.details ?? {};

  if (item.type === "quick_create_done") {
    const cleanedTitle = stripQuickCreatePrefix(item.title, details.identifier);
    if (cleanedTitle) return cleanedTitle;

    const prompt = singleLine(details.original_prompt);
    if (prompt) return prompt;
  }

  if (item.type === "quick_create_failed") {
    const prompt = singleLine(details.original_prompt);
    if (prompt) return prompt;
  }

  return item.title;
}

export function getQuickCreateFailureDetail(item: InboxItem): string {
  const details = item.details ?? {};
  return singleLine(details.error) || singleLine(item.body);
}

export function getInboxAIMeIntent(item: InboxItem): AIMeThinkIntent {
  switch (item.type) {
    case "new_comment":
    case "mentioned":
    case "review_requested":
      return "reply";
    case "task_failed":
    case "agent_blocked":
    case "quick_create_failed":
      return "plan";
    case "issue_assigned":
    case "status_changed":
    case "priority_changed":
    case "due_date_changed":
    case "assignee_changed":
    case "unassigned":
      return "triage";
    default:
      return "general";
  }
}

export function buildInboxAIMeInput(
  item: InboxItem,
  labels?: { title?: string; typeLabel?: string },
): string {
  const details = item.details ?? {};
  const detailsText = Object.entries(details)
    .filter(([, value]) => singleLine(value))
    .map(([key, value]) => `${key}: ${value.trim()}`)
    .join("\n");
  const title = labels?.title || getInboxDisplayTitle(item);
  const typeLabel = labels?.typeLabel || item.type;

  return [
    `收件箱事件：${title}`,
    `事件类型：${typeLabel}`,
    `严重程度：${item.severity}`,
    item.issue_id ? `关联 Issue：${item.issue_id}` : "",
    item.body ? `原始内容：\n${item.body.trim()}` : "",
    detailsText ? `事件细节：\n${detailsText}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
