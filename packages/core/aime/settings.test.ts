import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AIME_WORKSPACE_SETTINGS,
  getAIMeWorkspaceSettings,
  mergeAIMeWorkspaceSettings,
} from "./settings";

describe("AI-Me workspace settings", () => {
  it("returns stable defaults when workspace settings are missing", () => {
    expect(getAIMeWorkspaceSettings(undefined)).toEqual(
      DEFAULT_AIME_WORKSPACE_SETTINGS,
    );
  });

  it("normalizes invalid persisted values", () => {
    expect(
      getAIMeWorkspaceSettings({
        ai_me: {
          enabled: "yes",
          autonomy_level: "too_much",
          approval_mode: "sometimes",
          digest_cadence: "weekly",
          timezone: "",
          working_hours: {
            start: "9am",
            end: "18:00",
          },
          model_provider: "unknown",
          model_name: "",
          memory_retention_days: -1,
          data_retention_days: "abc",
        },
      }),
    ).toEqual({
      ...DEFAULT_AIME_WORKSPACE_SETTINGS,
      working_hours: {
        start: DEFAULT_AIME_WORKSPACE_SETTINGS.working_hours.start,
        end: "18:00",
      },
    });
  });

  it("merges AI-Me settings without dropping other workspace settings", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-08T10:00:00.000Z"));

    const merged = mergeAIMeWorkspaceSettings(
      {
        co_authored_by_enabled: false,
        unrelated: { keep: true },
      },
      {
        ...DEFAULT_AIME_WORKSPACE_SETTINGS,
        enabled: false,
        autonomy_level: "autonomous",
      },
    );

    expect(merged).toMatchObject({
      co_authored_by_enabled: false,
      unrelated: { keep: true },
      ai_me: {
        enabled: false,
        autonomy_level: "autonomous",
        updated_at: "2026-07-08T10:00:00.000Z",
      },
    });

    vi.useRealTimers();
  });
});
