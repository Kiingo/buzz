// Generated from the Kiingo surface renderer packages at c72e3863b9419a77a51b527a9ff4255646c6384c; do not edit here.
import { Fragment, type ReactNode } from "react";
import {
  parseMarkdown,
  type MarkdownBudget,
  type MdBlock,
  type MdInline,
} from "../core";

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
}: {
  text: string;
  onLink: (url: string) => void;
  /** The surface's Markdown allowance for this render (79 S2). */
  budget?: MarkdownBudget;
}) => (
  <div className="space-y-2 break-words text-sm leading-relaxed">
    {renderBlocks(parseMarkdown(text, budget), onLink)}
  </div>
);

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
      return (
        <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs">
          <code>{block.text}</code>
        </pre>
      );
    case "rule":
      return <hr className="border-border" />;
  }
};

const renderInline = (
  nodes: MdInline[],
  onLink: (url: string) => void,
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
      case "link":
        // A button, not <a href>: middle-click and auxclick can't skip the
        // outside-link confirmation (79 nit).
        return (
          <button
            key={index}
            type="button"
            title={node.href}
            className="inline p-0 text-left text-primary underline underline-offset-2"
            onClick={() => onLink(node.href)}
          >
            {renderInline(node.children, onLink)}
          </button>
        );
      default:
        return null;
    }
  });
