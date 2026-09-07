// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { StreamingMarkdown } from "./StreamingMarkdown";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("突发收到大量文本时按动画帧渐进展示，而不是整段瞬间出现", async () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const answer = "这是一段需要平滑展示的模型回复。".repeat(20);

  const { container } = render(<StreamingMarkdown text={answer} completed={false} />);

  expect(container.textContent).toBe("");
  await act(() => frames.shift()?.(0));
  await act(() => frames.shift()?.(100));
  expect(container.textContent?.length).toBeGreaterThan(0);
  expect(container.textContent?.length).toBeLessThan(answer.length);
  expect(container.textContent).not.toBe(answer);
});

it("窗口动画帧暂停时仍通过低频兜底推进显示", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const answer = "后台窗口也不能永久卡在正在完成状态。".repeat(10);

  const { container } = render(<StreamingMarkdown text={answer} completed={false} />);
  expect(container.textContent).toBe("");

  await act(() => vi.advanceTimersByTime(250));
  expect(container.textContent?.length).toBeGreaterThan(0);
  expect(container.textContent?.length).toBeLessThan(answer.length);
});
