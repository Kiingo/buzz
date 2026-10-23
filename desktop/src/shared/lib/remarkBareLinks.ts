/**
 * Remark plugin that makes link-like prose clickable when it is not written
 * as a Markdown link: bare domains, `www.` hosts, emails and clearly
 * formatted phone numbers (see `findBareLinks` and `docs/bare-links.md`).
 *
 * Runs after the other inline plugins, so it only sees plain text that GFM,
 * mentions, channel links, custom emoji and Buzz deep links left alone. It
 * descends only into ordinary prose containers: never into code, inline
 * code, links, HTML or the custom mention/channel/emoji nodes.
 *
 * It also opens GFM's `www.` literal autolinks over https, matching linkified
 * bare domains (GFM defaults those to http).
 */

import { findBareLinks } from "./bareLinks";

type Node = {
  // biome-ignore lint/suspicious/noExplicitAny: building mdast-compatible nodes
  [key: string]: any;
};

const PROSE_CONTAINERS = new Set([
  "root",
  "paragraph",
  "heading",
  "blockquote",
  "list",
  "listItem",
  "table",
  "tableRow",
  "tableCell",
  "emphasis",
  "strong",
  "delete",
  "spoiler",
]);

export default function remarkBareLinks() {
  return (tree: Node) => {
    transform(tree);
  };
}

function transform(node: Node) {
  if (!Array.isArray(node.children)) return;
  const next: Node[] = [];
  for (const child of node.children) {
    if (child.type === "text") {
      next.push(...splitText(child));
      continue;
    }
    if (child.type === "link") {
      upgradeWwwLiteral(child);
    } else if (PROSE_CONTAINERS.has(child.type)) {
      transform(child);
    }
    next.push(child);
  }
  node.children = next;
}

function splitText(node: Node): Node[] {
  const value: string = node.value ?? "";
  const links = findBareLinks(value);
  if (links.length === 0) return [node];
  const parts: Node[] = [];
  let offset = 0;
  for (const link of links) {
    if (link.start > offset) {
      parts.push({ type: "text", value: value.slice(offset, link.start) });
    }
    parts.push({
      type: "link",
      url: link.href,
      title: null,
      children: [{ type: "text", value: link.text }],
    });
    offset = link.end;
  }
  if (offset < value.length) {
    parts.push({ type: "text", value: value.slice(offset) });
  }
  return parts;
}

/** `www.example.com` autolinked by GFM as `http://www.example.com`. */
function upgradeWwwLiteral(link: Node) {
  const url: unknown = link.url;
  if (typeof url !== "string" || !url.startsWith("http://www.")) return;
  const only = link.children?.length === 1 ? link.children[0] : null;
  if (only?.type !== "text" || only.value !== url.slice("http://".length)) {
    return;
  }
  link.url = `https://${only.value}`;
}
