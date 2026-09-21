import { useEffect, useRef, useState } from "react";

import { MarkdownContent } from "./MarkdownContent";

type StreamingMarkdownProps = {
  text: string;
  completed: boolean;
  onSettled?: () => void;
};

/**
 * 把 Runtime 已接收的完整文本和用户当前看到的文本分离。
 * 网络层始终全速消费事件，这里只控制显示游标，避免模型突发增量造成整段闪现。
 */
export function StreamingMarkdown({ text, completed, onSettled }: StreamingMarkdownProps) {
  const targetRef = useRef(text);
  const visibleLengthRef = useRef(0);
  const frameRef = useRef<{ animationFrame: number; fallbackTimer: number } | null>(null);
  const lastFrameAtRef = useRef<number | null>(null);
  const revealCreditRef = useRef(0);
  const settledNotifiedRef = useRef(false);
  const onSettledRef = useRef(onSettled);
  const [visibleLength, setVisibleLength] = useState(0);

  onSettledRef.current = onSettled;

  function ensureFrame() {
    if (frameRef.current !== null || visibleLengthRef.current >= targetRef.current.length) return;
    let advanced = false;
    const advance = (timestamp = performance.now()) => {
      if (advanced) return;
      advanced = true;
      cancelScheduledFrame();
      advanceDisplayCursor(timestamp);
    };
    const pending = { animationFrame: 0, fallbackTimer: 0 };
    frameRef.current = pending;
    pending.animationFrame = requestAnimationFrame(advance);
    // Chromium 会暂停后台窗口的动画帧，低频计时器避免完成交接永久等待。
    pending.fallbackTimer = window.setTimeout(() => advance(), 100);
  }

  function advanceDisplayCursor(timestamp: number) {
    const previousFrameAt = lastFrameAtRef.current;
    lastFrameAtRef.current = timestamp;
    if (previousFrameAt === null) {
      ensureFrame();
      return;
    }

    const elapsedMs = Math.min(Math.max(timestamp - previousFrameAt, 0), 100);
    const remaining = targetRef.current.length - visibleLengthRef.current;
    revealCreditRef.current += (elapsedMs * charactersPerSecond(remaining)) / 1_000;
    const characterBudget = Math.floor(revealCreditRef.current);
    if (characterBudget > 0) {
      revealCreditRef.current -= characterBudget;
      const nextLength = advanceByCodePoints(
        targetRef.current,
        visibleLengthRef.current,
        characterBudget,
      );
      visibleLengthRef.current = nextLength;
      setVisibleLength(nextLength);
    }
    ensureFrame();
  }

  useEffect(() => {
    const previousTarget = targetRef.current;
    const visiblePrefix = previousTarget.slice(0, visibleLengthRef.current);
    targetRef.current = text;
    settledNotifiedRef.current = false;

    // 断线恢复可能用权威快照改写目标；只有仍是同一前缀时才保留显示游标。
    if (!text.startsWith(visiblePrefix)) {
      visibleLengthRef.current = 0;
      revealCreditRef.current = 0;
      setVisibleLength(0);
    }

    if (prefersReducedMotion()) {
      visibleLengthRef.current = text.length;
      setVisibleLength(text.length);
      return;
    }
    ensureFrame();
  }, [text]);

  useEffect(() => {
    return () => {
      cancelScheduledFrame();
    };
  }, []);

  useEffect(() => {
    if (!completed || visibleLength < text.length || settledNotifiedRef.current) return;
    settledNotifiedRef.current = true;
    onSettledRef.current?.();
  }, [completed, text, visibleLength]);

  function cancelScheduledFrame() {
    const pending = frameRef.current;
    if (pending === null) return;
    cancelAnimationFrame(pending.animationFrame);
    window.clearTimeout(pending.fallbackTimer);
    frameRef.current = null;
  }

  return <MarkdownContent text={text.slice(0, visibleLength)} streaming={!completed} />;
}

function charactersPerSecond(remaining: number) {
  if (remaining > 1_600) return 360;
  if (remaining > 700) return 220;
  if (remaining > 240) return 120;
  return 56;
}

function advanceByCodePoints(text: string, start: number, count: number) {
  let cursor = start;
  for (let index = 0; index < count && cursor < text.length; index += 1) {
    const codePoint = text.codePointAt(cursor);
    cursor += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
  }
  return cursor;
}

function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}
