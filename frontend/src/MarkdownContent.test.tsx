// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { MarkdownContent } from "./MarkdownContent";

afterEach(cleanup);

it("模型输出中的原始 HTML 和危险链接不能扩展页面执行边界", async () => {
  const { container } = render(
    <MarkdownContent text={'<script>alert("xss")</script>\n\n[危险链接](javascript:alert(1))\n\n**安全正文**'} />,
  );

  // CI 并行运行构建与测试时，首次解析懒加载 Markdown 分包可能超过默认 1 秒。
  await screen.findByText("安全正文", undefined, { timeout: 5_000 });
  expect(container.querySelector("script")).toBeNull();
  expect(screen.getByText("危险链接").tagName).toBe("SPAN");
  expect(screen.getByText("安全正文").tagName).toBe("STRONG");
});
