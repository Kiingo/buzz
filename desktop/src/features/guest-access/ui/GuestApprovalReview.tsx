import * as React from "react";
import { ExternalLink } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { Button } from "@/shared/ui/button";
import { Textarea } from "@/shared/ui/textarea";

import { requesterLabel } from "../lib/copy";
import type { GuestApproval } from "../lib/wire";
import {
  useApprovalDecision,
  type DecisionInput,
} from "../useApprovalDecision";
import { ApprovalDetails } from "./ApprovalDetails";
import {
  DEFAULT_GRANT_DAYS,
  GrantScopePicker,
  grantForChoice,
  type GrantChoice,
} from "./GrantScopePicker";

const STATE_TEXT: Record<string, string> = {
  approved: "Approved. The reply has been sent.",
  denied: "Declined. They were told you declined to share that.",
  expired: "This request expired before it was decided.",
  cancelled: "This request was cancelled.",
};

/**
 * Owner review of one held guest reply: the details, an optional edit of the
 * exact text, a grant scope, and Approve / Edit then approve / Deny / Deny and
 * block person. No new model turn runs after approval; the text shown (or the
 * edited text) is what gets published.
 */
export function GuestApprovalReview({
  approval,
  onDone,
}: {
  approval: GuestApproval;
  onDone?: () => void;
}) {
  const decision = useApprovalDecision(approval);
  const [editing, setEditing] = React.useState(false);
  const [editedText, setEditedText] = React.useState(approval.draftText ?? "");
  const [grant, setGrant] = React.useState<GrantChoice>({
    scope: "once",
    days: DEFAULT_GRANT_DAYS,
  });
  const [confirmBlock, setConfirmBlock] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const requester = requesterLabel(approval.requester);

  if (approval.state !== "pending") {
    return (
      <div className="space-y-3">
        <ApprovalDetails approval={approval} />
        <p className="text-sm text-muted-foreground" role="status">
          {STATE_TEXT[approval.state] ?? "This request is no longer pending."}
        </p>
      </div>
    );
  }

  const run = async (input: DecisionInput) => {
    const result = await decision.submit(input);
    if (!result) return;
    setNotice(
      result.alreadyDecided
        ? "This request was already decided elsewhere."
        : null,
    );
    onDone?.();
  };

  const trimmedEdit = editedText.trim();
  const editChanged = trimmedEdit !== (approval.draftText ?? "").trim();

  return (
    <div className="space-y-4" data-testid="guest-approval-review">
      <ApprovalDetails approval={approval} showDraft={!editing} />

      {editing ? (
        <section>
          <label
            className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted-foreground"
            htmlFor={`guest-approval-edit-${approval.approvalId}`}
          >
            Edit the reply. This exact text will be sent.
          </label>
          <Textarea
            className="min-h-32 text-sm"
            data-testid="guest-approval-edit"
            disabled={decision.isPending}
            id={`guest-approval-edit-${approval.approvalId}`}
            onChange={(event) => setEditedText(event.target.value)}
            value={editedText}
          />
        </section>
      ) : null}

      <GrantScopePicker
        disabled={decision.isPending}
        onChange={setGrant}
        requesterLinked={approval.requester.linked}
        requesterName={requester}
        value={grant}
      />

      {decision.error ? (
        <p className="text-sm text-destructive" role="alert">
          {decision.error}
        </p>
      ) : null}
      {notice ? (
        <p className="text-sm text-muted-foreground" role="status">
          {notice}
        </p>
      ) : null}

      {confirmBlock ? (
        <div
          className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm"
          data-testid="guest-approval-block-confirm"
        >
          <p>
            Decline and block {requester}? Your agents will stop answering them
            until you unblock them in agent settings.
          </p>
          <div className="flex justify-end gap-2">
            <Button
              disabled={decision.isPending}
              onClick={() => setConfirmBlock(false)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Keep reviewing
            </Button>
            <Button
              data-testid="guest-approval-deny-block-confirm"
              disabled={decision.isPending}
              onClick={() => void run({ decision: "deny_and_block" })}
              size="sm"
              type="button"
              variant="destructive"
            >
              Decline and block
            </Button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          <Button
            data-testid="guest-approval-deny-block"
            disabled={decision.isPending || confirmBlock}
            onClick={() => setConfirmBlock(true)}
            size="sm"
            type="button"
            variant="ghost"
          >
            Deny and block person
          </Button>
          <Button
            data-testid="guest-approval-deny"
            disabled={decision.isPending}
            onClick={() => void run({ decision: "deny" })}
            size="sm"
            type="button"
            variant="outline"
          >
            Deny
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          {editing ? (
            <>
              <Button
                disabled={decision.isPending}
                onClick={() => {
                  setEditing(false);
                  setEditedText(approval.draftText ?? "");
                }}
                size="sm"
                type="button"
                variant="ghost"
              >
                Cancel edit
              </Button>
              <Button
                data-testid="guest-approval-approve-edited"
                disabled={decision.isPending || trimmedEdit.length === 0}
                onClick={() =>
                  void run(
                    editChanged
                      ? {
                          decision: "approve_edited",
                          editedText: trimmedEdit,
                          grant: grantForChoice(grant),
                        }
                      : { decision: "approve", grant: grantForChoice(grant) },
                  )
                }
                size="sm"
                type="button"
              >
                {decision.isPending ? "Sending…" : "Approve edited reply"}
              </Button>
            </>
          ) : (
            <>
              <Button
                data-testid="guest-approval-edit-start"
                disabled={decision.isPending}
                onClick={() => setEditing(true)}
                size="sm"
                type="button"
                variant="outline"
              >
                Edit then approve
              </Button>
              <Button
                data-testid="guest-approval-approve"
                disabled={decision.isPending}
                onClick={() =>
                  void run({
                    decision: "approve",
                    grant: grantForChoice(grant),
                  })
                }
                size="sm"
                type="button"
              >
                {decision.isPending ? "Sending…" : "Approve"}
              </Button>
            </>
          )}
        </div>
      </div>

      {approval.approvalUrl ? (
        <button
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
          onClick={() => void openUrl(approval.approvalUrl ?? "")}
          type="button"
        >
          <ExternalLink aria-hidden className="h-3 w-3" />
          Open in browser
        </button>
      ) : null}
    </div>
  );
}
