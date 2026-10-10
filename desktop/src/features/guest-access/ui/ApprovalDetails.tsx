import { Hash, Link2, Link2Off, Lock, MessageSquare } from "lucide-react";

import { Badge } from "@/shared/ui/badge";

import {
  approvalReason,
  classifierReason,
  dataSourceLabel,
  requesterLabel,
  scorePercent,
} from "../lib/copy";
import type { GuestApproval } from "../lib/wire";

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <dt className="w-28 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-foreground">{children}</dd>
    </div>
  );
}

function formatWhen(iso: string | null): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at.toLocaleString();
}

/**
 * Everything an owner reviews before releasing a guest reply: who asked and
 * where, what they asked, the exact draft, which data it used, and why it was
 * held, in plain language.
 */
export function ApprovalDetails({
  approval,
  showDraft = true,
}: {
  approval: GuestApproval;
  showDraft?: boolean;
}) {
  const requester = requesterLabel(approval.requester);
  const agent = approval.agent.displayName ?? "Your agent";
  const ownerOnly = new Set(approval.ownerOnlySources);
  const reasons = approval.reasonCodes.map(approvalReason);
  const flags = approval.classifier.categories;
  const scores = Object.entries(approval.classifier.topScores)
    .filter(([, score]) => score >= 0.4)
    .sort((a, b) => b[1] - a[1]);
  const expires = formatWhen(approval.expiresAt);

  return (
    <div className="space-y-3" data-testid="guest-approval-details">
      <dl className="space-y-2 rounded-xl border border-border/60 bg-muted/25 p-3 text-sm">
        <Row label="From">
          <span className="inline-flex flex-wrap items-center gap-2">
            <span className="font-medium">{requester}</span>
            {approval.requester.linked ? (
              <Badge variant="success">
                <Link2 aria-hidden className="mr-1 h-3 w-3" />
                Linked account
              </Badge>
            ) : (
              <Badge variant="warning">
                <Link2Off aria-hidden className="mr-1 h-3 w-3" />
                Not linked
              </Badge>
            )}
            {approval.requester.viaAgentPubkey ? (
              <span className="text-xs text-muted-foreground">
                asked through their agent
              </span>
            ) : null}
          </span>
        </Row>
        <Row label="Asked">{agent}</Row>
        <Row label="Where">
          {approval.channel.type === "dm" ? (
            <span className="inline-flex items-center gap-1">
              <MessageSquare aria-hidden className="h-3.5 w-3.5" />
              Direct message
            </span>
          ) : (
            <span className="inline-flex items-center gap-1">
              <Hash aria-hidden className="h-3.5 w-3.5" />
              {approval.channel.name ?? "a channel"}
              {approval.channel.audienceTotal
                ? ` · ${approval.channel.audienceTotal} people can see the reply`
                : null}
            </span>
          )}
        </Row>
        {expires ? <Row label="Expires">{expires}</Row> : null}
      </dl>

      {approval.questionText ? (
        <section>
          <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Their message
          </h4>
          <blockquote
            className="whitespace-pre-wrap break-words rounded-lg border-l-2 border-border bg-muted/20 px-3 py-2 text-sm text-foreground"
            data-testid="guest-approval-question"
          >
            {approval.questionText}
          </blockquote>
        </section>
      ) : null}

      {showDraft ? (
        <section>
          <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Reply that will be sent, exactly as written
          </h4>
          <pre
            className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/70 bg-background px-3 py-2 font-sans text-sm text-foreground"
            data-testid="guest-approval-draft"
          >
            {approval.draftText ?? ""}
          </pre>
        </section>
      ) : null}

      <section>
        <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Information used
        </h4>
        {approval.dataSources.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No private data was read.
          </p>
        ) : (
          <ul
            className="flex flex-wrap gap-1.5"
            data-testid="guest-approval-sources"
          >
            {approval.dataSources.map((source) => (
              <li key={source}>
                <Badge variant={ownerOnly.has(source) ? "warning" : "outline"}>
                  {ownerOnly.has(source) ? (
                    <Lock aria-hidden className="mr-1 h-3 w-3" />
                  ) : null}
                  {dataSourceLabel(source)}
                  {ownerOnly.has(source) ? " · only you can see this" : null}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </section>

      {reasons.length > 0 || flags.length > 0 ? (
        <section data-testid="guest-approval-reasons">
          <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Why this needs you
          </h4>
          <ul className="list-disc space-y-0.5 pl-5 text-sm text-foreground">
            {reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
            {flags.map((category) => (
              <li key={category}>{classifierReason(category)}</li>
            ))}
          </ul>
          {scores.length > 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Safety check:{" "}
              {scores
                .map(
                  ([name, score]) =>
                    `${name.replace(/_/g, " ")} ${scorePercent(score)}`,
                )
                .join(" · ")}
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
