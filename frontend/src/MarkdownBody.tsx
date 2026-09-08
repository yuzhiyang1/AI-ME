import type { AnchorHTMLAttributes, ImgHTMLAttributes } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type MarkdownBodyProps = {
  text: string;
  streaming: boolean;
};

/** 模型输出的 Markdown 解析边界：支持 GFM，但不接受原始 HTML。 */
export function MarkdownBody({ text, streaming }: MarkdownBodyProps) {
  return (
    <div className="markdown-content" data-streaming={streaming || undefined}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: SafeMarkdownLink,
          img: SafeMarkdownImage,
          table: ({ children, ...props }) => (
            <div className="markdown-table-scroll">
              <table {...props}>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function SafeMarkdownLink({ href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  if (!href || !isAllowedExternalUrl(href)) {
    return <span className="markdown-link-blocked">{children}</span>;
  }
  return (
    <a {...props} href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

function SafeMarkdownImage({ src, alt, ...props }: ImgHTMLAttributes<HTMLImageElement>) {
  if (typeof src !== "string" || !isAllowedImageUrl(src)) {
    return <span className="markdown-image-blocked">[{alt || "图片"}]</span>;
  }
  return (
    <img
      {...props}
      src={src}
      alt={alt ?? ""}
      loading="lazy"
      referrerPolicy="no-referrer"
    />
  );
}

function isAllowedExternalUrl(url: string) {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "https:" || protocol === "http:" || protocol === "mailto:";
  } catch {
    return false;
  }
}

function isAllowedImageUrl(url: string) {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}
