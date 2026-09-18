// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SessionUsageBar } from "./SessionUsageBar";

describe("SessionUsageBar", () => {
  it("显示持久窗口编号并保留累计用量", () => {
    render(<SessionUsageBar fallbackContextWindow={32000} usage={{
      inputTokens: 200, outputTokens: 50, totalTokens: 250,
      currentContextTokens: 250, contextWindow: 32000,
      measuredSteps: 1, unreportedSteps: 0, untrackedHistory: false,
      windowNumber: 3,
    }} />);
    expect(screen.getByText("上下文 · 窗口 3")).toBeTruthy();
    expect(screen.getByText("合计 250")).toBeTruthy();
  });
});
