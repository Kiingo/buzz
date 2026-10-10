import * as React from "react";

import { Button } from "@/shared/ui/button";
import { Textarea } from "@/shared/ui/textarea";

import { guestAccessApi } from "../../lib/client";
import { useOwnerMutation, useOwnerShareables } from "../../ownerQueries";
import { MutationError, QueryState, formatDate } from "./shared";

const KIND_LABEL: Record<string, string> = {
  status: "Status",
  note: "Note or decision",
  knowledge_item: "Knowledge item",
};

type NewItem = {
  kind: "status" | "note";
  content: string;
  days: number | null;
};

/**
 * Items marked "shared via my agent": the only things otherwise private to
 * you that your agent may share with anyone in your org who asks.
 */
export function GuestSharedTab({
  guestEndpointId,
}: {
  guestEndpointId: string | null;
}) {
  const shareables = useOwnerShareables();
  const [draft, setDraft] = React.useState<NewItem>({
    kind: "status",
    content: "",
    days: null,
  });
  const add = useOwnerMutation((item: NewItem) =>
    guestAccessApi.addShareable({
      resourceKind: item.kind,
      content: item.content.trim(),
      guestEndpointId,
      expiresInDays: item.days ?? undefined,
    }),
  );
  const remove = useOwnerMutation((shareableId: string) =>
    guestAccessApi.removeShareable(shareableId),
  );
  const rows = (shareables.data ?? []).filter(
    (row) =>
      row.guestEndpointId === null || row.guestEndpointId === guestEndpointId,
  );

  return (
    <div className="space-y-4" data-testid="guest-shared-tab">
      <p className="text-sm text-muted-foreground">
        Mark notes, decisions and your status as “shared via my agent”. Anyone
        in your org who asks this agent can be told these, without your
        approval.
      </p>
      <form
        className="space-y-2 rounded-xl border border-border/60 p-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!draft.content.trim()) return;
          add.mutate(draft, {
            onSuccess: () => setDraft({ ...draft, content: "" }),
          });
        }}
      >
        <div className="flex flex-wrap gap-2">
          <select
            aria-label="What to share"
            className="rounded-md border border-border/70 bg-background px-2 py-1 text-sm"
            onChange={(event) =>
              setDraft({
                ...draft,
                kind: event.target.value as NewItem["kind"],
              })
            }
            value={draft.kind}
          >
            <option value="status">Status (“what I'm working on”)</option>
            <option value="note">Note or decision</option>
          </select>
          <select
            aria-label="Share for"
            className="rounded-md border border-border/70 bg-background px-2 py-1 text-sm"
            onChange={(event) =>
              setDraft({
                ...draft,
                days: event.target.value ? Number(event.target.value) : null,
              })
            }
            value={draft.days ?? ""}
          >
            <option value="">Until I remove it</option>
            <option value="1">For 1 day</option>
            <option value="7">For 7 days</option>
            <option value="30">For 30 days</option>
          </select>
        </div>
        <Textarea
          aria-label="Shared text"
          className="min-h-20 text-sm"
          data-testid="guest-shared-content"
          maxLength={8192}
          onChange={(event) =>
            setDraft({ ...draft, content: event.target.value })
          }
          placeholder={
            draft.kind === "status"
              ? "Heads down on the Q4 pricing review until Friday."
              : "We decided to move the launch to November 3."
          }
          value={draft.content}
        />
        <div className="flex justify-end">
          <Button
            data-testid="guest-shared-add"
            disabled={add.isPending || !draft.content.trim()}
            size="sm"
            type="submit"
          >
            Share via my agent
          </Button>
        </div>
        <MutationError error={add.error} />
      </form>
      <QueryState
        empty={rows.length === 0}
        emptyText="Nothing is shared yet."
        error={shareables.error}
        isLoading={shareables.isLoading}
        onRetry={() => void shareables.refetch()}
      >
        <ul className="divide-y divide-border/60">
          {rows.map((row) => (
            <li
              className="flex items-start justify-between gap-3 py-3 text-sm"
              data-testid="guest-shared-row"
              key={row.shareableId}
            >
              <div className="min-w-0">
                <p className="text-xs font-medium text-muted-foreground">
                  {KIND_LABEL[row.resourceKind] ?? row.resourceKind}
                  {row.guestEndpointId ? " · this agent" : " · all your agents"}
                  {row.expiresAt ? ` · until ${formatDate(row.expiresAt)}` : ""}
                </p>
                <p className="whitespace-pre-wrap break-words">
                  {row.content ?? row.resourceId ?? ""}
                </p>
              </div>
              <Button
                disabled={remove.isPending}
                onClick={() => remove.mutate(row.shareableId)}
                size="sm"
                type="button"
                variant="outline"
              >
                Stop sharing
              </Button>
            </li>
          ))}
        </ul>
      </QueryState>
      <MutationError error={remove.error} />
    </div>
  );
}
