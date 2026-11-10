// Generated from the Kiingo surface renderer packages at 23394ec833a81a2fb1d9cfb5c0a7fcc34cd1b948; do not edit here.
import { createContext, Fragment, useContext, type ReactNode } from "react";
import {
  parseInline,
  parseMarkdown,
  type MarkdownBudget,
  type MdAlign,
  type MdBlock,
  type MdInline,
} from "../core";
import { cn } from "./cn";
import { CopyButton } from "./copy";

/** Whether code fences get a Copy control (Markdown's `copyable`, default on). */
const CodeCopy = createContext(true);

const CodeFence = ({ text }: { text: string }) => {
  const copyable = useContext(CodeCopy);
  return (
    <div className="overflow-hidden rounded-md bg-muted">
      {copyable ? (
        <div className="flex justify-end px-2 pt-1">
          <CopyButton text={text} what="code" />
        </div>
      ) : null}
      <pre
        className={cn(
          "overflow-x-auto px-3 font-mono text-xs",
          copyable ? "pb-2" : "py-2",
        )}
      >
        <code>{text}</code>
      </pre>
    </div>
  );
};

/**
 * The safe Markdown subset (§3) drawn with the app's own elements from the
 * core's parse tree: never `dangerouslySetInnerHTML`, never agent HTML.
 * Links are only what `openableUrl` allowed (https and Kiingo deep links)
 * and open through the host, outside hosts confirmed first.
 */
export const MarkdownText = ({
  text,
  onLink,
  budget,
  copyCode = true,
  small = false,
}: {
  text: string;
  onLink: (url: string) => void;
  /** The surface's Markdown allowance for this render (79 S2). */
  budget?: MarkdownBudget;
  /** A Copy control on each code fence (default on). */
  copyCode?: boolean;
  /** The smaller size (a Callout's body). */
  small?: boolean;
}) => (
  <CodeCopy.Provider value={copyCode}>
    <div
      className={cn(
        "space-y-2 break-words leading-relaxed",
        small ? "text-xs" : "text-sm",
      )}
    >
      {renderBlocks(parseMarkdown(text, budget), onLink)}
    </div>
  </CodeCopy.Provider>
);

/**
 * An agent's prose field (the catalog's `inlineMarkdown`: Text, KeyValue
 * values, List subtitles, Table text cells, Timeline bodies; Ross
 * 2026-11-03: a `[label](url)` in a card showed as raw Markdown): inline
 * Markdown only, from the same safe parser as `MarkdownText`: bold,
 * italic, strikethrough, code and links, line breaks kept; block syntax
 * and raw HTML stay literal text. Links are only what `openableUrl`
 * allowed and open through the host (outside hosts confirmed first).
 * `links: false` (inside a tappable row) draws a link as its words.
 * Outside content never comes here: callers quote it.
 */
export const InlineMarkdown = ({
  text,
  onLink,
  links = true,
}: {
  text: string;
  onLink: (url: string) => void;
  links?: boolean;
}) => <>{renderInline(parseInline(text), links ? onLink : undefined)}</>;

const renderBlocks = (
  blocks: MdBlock[],
  onLink: (url: string) => void,
): ReactNode =>
  blocks.map((block, index) => (
    <Fragment key={index}>{renderBlock(block, onLink)}</Fragment>
  ));

const renderBlock = (
  block: MdBlock,
  onLink: (url: string) => void,
): ReactNode => {
  switch (block.kind) {
    case "paragraph":
      return <p>{renderInline(block.children, onLink)}</p>;
    case "heading": {
      const content = renderInline(block.children, onLink);
      if (block.level === 1) {
        return <h3 className="text-base font-semibold">{content}</h3>;
      }
      if (block.level === 2) {
        return <h4 className="text-sm font-semibold">{content}</h4>;
      }
      return <h5 className="text-sm font-medium">{content}</h5>;
    }
    case "list": {
      const items = block.items.map((item, index) => (
        <li key={index} className="space-y-1">
          {renderBlocks(item, onLink)}
        </li>
      ));
      return block.ordered ? (
        <ol className="list-decimal space-y-1 pl-5" start={block.start}>
          {items}
        </ol>
      ) : (
        <ul className="list-disc space-y-1 pl-5">{items}</ul>
      );
    }
    case "quote":
      return (
        <blockquote className="space-y-2 border-l-2 border-border pl-3 text-muted-foreground">
          {renderBlocks(block.children, onLink)}
        </blockquote>
      );
    case "code":
      return <CodeFence text={block.text} />;
    case "rule":
      return <hr className="border-border" />;
    case "table":
      return (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-muted/50">
              <tr>
                {block.header.map((cell, index) => (
                  <th
                    key={index}
                    className={cn(
                      "border-b border-border px-2 py-1.5 font-medium",
                      alignClass(block.align[index] ?? null),
                    )}
                  >
                    {renderInline(cell, onLink)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr
                  key={rowIndex}
                  className="border-b border-border last:border-b-0"
                >
                  {row.map((cell, index) => (
                    <td
                      key={index}
                      className={cn(
                        "px-2 py-1.5 align-top",
                        alignClass(block.align[index] ?? null),
                      )}
                    >
                      {renderInline(cell, onLink)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
};

const alignClass = (align: MdAlign): string =>
  align === "center"
    ? "text-center"
    : align === "right"
      ? "text-right"
      : "text-left";

const renderInline = (
  nodes: MdInline[],
  /** Undefined: links draw as their words (no nested button). */
  onLink: ((url: string) => void) | undefined,
): ReactNode =>
  nodes.map((node, index) => {
    switch (node.kind) {
      case "text":
        return <Fragment key={index}>{node.text}</Fragment>;
      case "break":
        return <br key={index} />;
      case "strong":
        return (
          <strong key={index}>{renderInline(node.children, onLink)}</strong>
        );
      case "em":
        return <em key={index}>{renderInline(node.children, onLink)}</em>;
      case "del":
        return <del key={index}>{renderInline(node.children, onLink)}</del>;
      case "code":
        return (
          <code
            key={index}
            className="rounded bg-muted px-1 py-0.5 font-mono text-xs"
          >
            {node.text}
          </code>
        );
      case "link": {
        const open = onLink;
        if (!open) {
          return (
            <Fragment key={index}>{renderInline(node.children, open)}</Fragment>
          );
        }
        // A button, not <a href>: middle-click and auxclick can't skip the
        // outside-link confirmation (79 nit).
        return (
          <button
            key={index}
            type="button"
            title={node.href}
            className="inline p-0 text-left text-primary underline underline-offset-2"
            onClick={() => open(node.href)}
          >
            {renderInline(node.children, open)}
          </button>
        );
      }
      default:
        return null;
    }
  });
