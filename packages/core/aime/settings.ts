export const AIME_WORKSPACE_SETTINGS_KEY = "ai_me";

export const AIME_AUTONOMY_LEVELS = ["assistive", "balanced", "autonomous"] as const;
export const AIME_APPROVAL_MODES = ["always", "risky", "never"] as const;
export const AIME_DIGEST_CADENCES = ["realtime", "daily", "muted"] as const;
export const AIME_MODEL_PROVIDERS = ["deepseek", "openai", "anthropic", "custom"] as const;

export type AIMeAutonomyLevel = (typeof AIME_AUTONOMY_LEVELS)[number];
export type AIMeApprovalMode = (typeof AIME_APPROVAL_MODES)[number];
export type AIMeDigestCadence = (typeof AIME_DIGEST_CADENCES)[number];
export type AIMeModelProvider = (typeof AIME_MODEL_PROVIDERS)[number];

export interface AIMeWorkingHours {
  start: string;
  end: string;
}

export interface AIMeWorkspaceSettings {
  enabled: boolean;
  autonomy_level: AIMeAutonomyLevel;
  approval_mode: AIMeApprovalMode;
  digest_cadence: AIMeDigestCadence;
  timezone: string;
  working_hours: AIMeWorkingHours;
  model_provider: AIMeModelProvider;
  model_name: string;
  memory_retention_days: number;
  data_retention_days: number;
  updated_at: string | null;
}

export const DEFAULT_AIME_WORKSPACE_SETTINGS: AIMeWorkspaceSettings = {
  enabled: true,
  autonomy_level: "balanced",
  approval_mode: "risky",
  digest_cadence: "realtime",
  timezone: "Asia/Shanghai",
  working_hours: {
    start: "09:00",
    end: "18:00",
  },
  model_provider: "deepseek",
  model_name: "deepseek-chat",
  memory_retention_days: 180,
  data_retention_days: 365,
  updated_at: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickEnum<T extends readonly string[]>(
  value: unknown,
  options: T,
  fallback: T[number],
): T[number] {
  return typeof value === "string" && options.includes(value)
    ? value
    : fallback;
}

function pickString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function pickPositiveInteger(value: unknown, fallback: number): number {
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isInteger(numberValue) && numberValue > 0
    ? numberValue
    : fallback;
}

function pickTime(value: unknown, fallback: string): string {
  return typeof value === "string" && /^\d{2}:\d{2}$/.test(value)
    ? value
    : fallback;
}

export function getAIMeWorkspaceSettings(
  workspaceSettings: Record<string, unknown> | null | undefined,
): AIMeWorkspaceSettings {
  const raw = isRecord(workspaceSettings?.[AIME_WORKSPACE_SETTINGS_KEY])
    ? workspaceSettings[AIME_WORKSPACE_SETTINGS_KEY]
    : {};
  const workingHours = isRecord(raw.working_hours) ? raw.working_hours : {};

  return {
    enabled:
      typeof raw.enabled === "boolean"
        ? raw.enabled
        : DEFAULT_AIME_WORKSPACE_SETTINGS.enabled,
    autonomy_level: pickEnum(
      raw.autonomy_level,
      AIME_AUTONOMY_LEVELS,
      DEFAULT_AIME_WORKSPACE_SETTINGS.autonomy_level,
    ),
    approval_mode: pickEnum(
      raw.approval_mode,
      AIME_APPROVAL_MODES,
      DEFAULT_AIME_WORKSPACE_SETTINGS.approval_mode,
    ),
    digest_cadence: pickEnum(
      raw.digest_cadence,
      AIME_DIGEST_CADENCES,
      DEFAULT_AIME_WORKSPACE_SETTINGS.digest_cadence,
    ),
    timezone: pickString(raw.timezone, DEFAULT_AIME_WORKSPACE_SETTINGS.timezone),
    working_hours: {
      start: pickTime(
        workingHours.start,
        DEFAULT_AIME_WORKSPACE_SETTINGS.working_hours.start,
      ),
      end: pickTime(
        workingHours.end,
        DEFAULT_AIME_WORKSPACE_SETTINGS.working_hours.end,
      ),
    },
    model_provider: pickEnum(
      raw.model_provider,
      AIME_MODEL_PROVIDERS,
      DEFAULT_AIME_WORKSPACE_SETTINGS.model_provider,
    ),
    model_name: pickString(
      raw.model_name,
      DEFAULT_AIME_WORKSPACE_SETTINGS.model_name,
    ),
    memory_retention_days: pickPositiveInteger(
      raw.memory_retention_days,
      DEFAULT_AIME_WORKSPACE_SETTINGS.memory_retention_days,
    ),
    data_retention_days: pickPositiveInteger(
      raw.data_retention_days,
      DEFAULT_AIME_WORKSPACE_SETTINGS.data_retention_days,
    ),
    updated_at:
      typeof raw.updated_at === "string" && raw.updated_at.trim()
        ? raw.updated_at
        : null,
  };
}

export function mergeAIMeWorkspaceSettings(
  workspaceSettings: Record<string, unknown> | null | undefined,
  next: AIMeWorkspaceSettings,
): Record<string, unknown> {
  // Normalize through the public reader so persisted JSON keeps the same shape
  // even if callers pass a partial object from an older UI.
  const normalized = getAIMeWorkspaceSettings({
    [AIME_WORKSPACE_SETTINGS_KEY]: {
      ...next,
      updated_at: new Date().toISOString(),
    },
  });

  return {
    ...(workspaceSettings ?? {}),
    [AIME_WORKSPACE_SETTINGS_KEY]: normalized,
  };
}
