import { lazy, Suspense } from "react";

const MarkdownBody = lazy(() =>
  import("./MarkdownBody").then((module) => ({ default: module.MarkdownBody })),
);

type MarkdownContentProps = {
  text: string;
  streaming?: boolean;
};

/**
 * 延迟加载较重的 Markdown 解析链，空会话首屏无需承担解析器体积。
 * 流式调用只会传入已经越过显示游标的前缀，因此兜底也不会提前暴露尾部。
 */
export function MarkdownContent({ text, streaming = false }: MarkdownContentProps) {
  return (
    <Suspense fallback={<div className="markdown-content markdown-pending">{text}</div>}>
      <MarkdownBody text={text} streaming={streaming} />
    </Suspense>
  );
}
