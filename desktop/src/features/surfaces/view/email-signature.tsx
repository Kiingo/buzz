// Generated from the Kiingo surface renderer packages at dbc93b6d803e88e782fd6dbc8d7871827f2a9f7c; do not edit here.
import { useState } from "react";
import { isObject, type JsonValue } from "../core";
import { cn } from "./cn";
import { useNodeContext, type NodeProps } from "./context";
import { Glyphs } from "./icons";

// An email card's signature (Ross, 2026-11-04: it "takes up far too much
// space"; "add it as a button that you can expand"). One collapsed
// "Signature" row with a short status; open, it shows the approved signature
// from the server's own preview in a sandboxed frame (no scripts, no remote
// loads), or else as plain text with any markup taken out: never the HTML
// source. Display only: the card's data, what is sent and the shownDigest
// (which never reads the signature fields) don't change. Mac and iPhone draw
// the same row (UiEmailSignatureRow, UiEmailSignature).

/** Whether the card holds an approved signature (`/mailboxSignature`). */
const signatureApproved = (data: { [key: string]: JsonValue }): boolean =>
  isObject(data.mailboxSignature);

/** The row's status: the approved version, or none. */
export const emailSignatureStatus = (
  notice: string | undefined,
  approved: boolean,
): string => {
  if (!approved) {
    return "None approved";
  }
  const header = (notice ?? "").split("\n", 1)[0] ?? "";
  const version = header.split(" · ").pop() ?? "";
  return version.startsWith("Version ") ? `Approved · ${version}` : "Approved";
};

/** `text` without HTML markup; line breaks kept, common entities decoded. */
export const emailSignaturePlain = (text: string): string => {
  if (!text.includes("<") && !text.includes("&")) {
    return text.trim();
  }
  const stripped = text
    .replace(/<(style|script|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, "")
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<br\b[^>]*>/giu, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)\s*>/giu, "\n")
    .replace(/<[^>]*>/gu, "")
    .replace(/</gu, "")
    .replace(/&nbsp;/giu, " ")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&amp;/giu, "&");
  const folded: string[] = [];
  for (const line of stripped.split(/\r\n|\r|\n/u).map((part) => part.trim())) {
    if (
      line === "" &&
      (folded.length === 0 || folded[folded.length - 1] === "")
    ) {
      continue;
    }
    folded.push(line);
  }
  return folded.join("\n").trim();
};

/** The open row's text: the plain signature after the notice's header line,
 * or the whole notice when there is no approved signature. */
export const emailSignatureText = (
  notice: string | undefined,
  approved: boolean,
): string => {
  let text = notice ?? "";
  if (approved && text.startsWith("Approved signature")) {
    const end = text.indexOf("\n");
    text = end < 0 ? "" : text.slice(end);
  }
  return emailSignaturePlain(text);
};

export const EmailSignatureRow = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  const [open, setOpen] = useState(false);
  const notice = context.text(component, "text", scope, 20_000);
  const preview = context.surface.emailSignaturePreview;
  const approved = signatureApproved(context.data) || Boolean(preview);
  const bodyId = context.domId(component, scope, "-signature");
  const text = emailSignatureText(notice, approved);
  return (
    <section aria-label="Email signature" className="space-y-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Glyphs.right
          aria-hidden
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="text-sm font-medium">Signature</span>
        <span className="text-xs text-muted-foreground">
          {emailSignatureStatus(notice, approved)}
        </span>
      </button>
      {open ? (
        <div id={bodyId} className="pl-5">
          {preview ? (
            <iframe
              title="Complete approved email signature"
              sandbox=""
              referrerPolicy="no-referrer"
              srcDoc={`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline';"><style>body{margin:0;padding:8px;font:14px Arial;overflow-wrap:anywhere}img{max-width:100%!important;height:auto!important}</style></head><body>${preview.html}</body></html>`}
              className="h-48 w-full resize-y rounded border bg-white"
            />
          ) : text ? (
            <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
              {text}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
};
