import * as React from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import { History, LoaderCircle, Plus } from "lucide-react";
import { toast } from "sonner";

import { useKnownAgentPubkeys } from "@/features/agents/useKnownAgentPubkeys";
import { useSendMessageMutation } from "@/features/messages/hooks";
import { channelMessagesKey } from "@/features/messages/lib/messageQueryKeys";
import { useIdentityQuery } from "@/shared/api/hooks";
import type { Channel, RelayEvent } from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";

import { parseSessionsListing, type AgentSessionItem } from "../lib/markers";
import { useSessionControlsAvailable } from "../lib/sessionControls";
import {
  AGENT_DID_NOT_ANSWER,
  findFreshListing,
  findListingReply,
  LISTING_WAIT_MS,
  loadSessionCommand,
  NEW_SESSION_COMMAND,
  pickerReducer,
  SESSIONS_LIST_COMMAND,
} from "../lib/sessionsPicker";
import { sessionItemCaption, sessionItemTitle } from "./AgentSessionsListing";

const EMPTY_EVENTS: RelayEvent[] = [];

type Confirm =
  | { kind: "new" }
  | { kind: "load"; item: AgentSessionItem }
  | null;

/**
 * DM header sessions picker for a 1:1 DM with an agent. Reuses a listing
 * under two minutes old, otherwise sends `/sessions` as an ordinary message
 * and waits up to 15 seconds for the agent's listing. New session and Load
 * confirm first and then send the command; the agent's acknowledgement
 * arrives in the conversation.
 */
export function AgentSessionsPicker({
  agentPubkey,
  channel,
  isAgentHint,
}: {
  agentPubkey: string;
  channel: Channel;
  isAgentHint: boolean;
}) {
  const knownAgents = useKnownAgentPubkeys();
  const isAgent = isAgentHint || knownAgents.has(normalizePubkey(agentPubkey));
  if (channel.channelType !== "dm" || !isAgent) return null;
  return <SessionControlsGate agentPubkey={agentPubkey} channel={channel} />;
}

/**
 * Offers the picker only when the provider says this agent's session
 * controls are available; hidden while unknown and on any lookup error.
 */
function SessionControlsGate({
  agentPubkey,
  channel,
}: {
  agentPubkey: string;
  channel: Channel;
}) {
  const available = useSessionControlsAvailable(agentPubkey);
  if (!available) return null;
  return <SessionsPicker agentPubkey={agentPubkey} channel={channel} />;
}

function SessionsPicker({
  agentPubkey,
  channel,
}: {
  agentPubkey: string;
  channel: Channel;
}) {
  const identity = useIdentityQuery().data;
  const sendMessage = useSendMessageMutation(channel, identity);
  const sendAsync = sendMessage.mutateAsync;
  // Passive read of the channel timeline cache; the channel screen owns the
  // fetch and live merge, this observer only follows it.
  const events =
    useQuery<RelayEvent[]>({
      queryKey: channelMessagesKey(channel.id),
      queryFn: skipToken,
    }).data ?? EMPTY_EVENTS;
  const [open, setOpen] = React.useState(false);
  const [state, dispatch] = React.useReducer(pickerReducer, {
    status: "idle",
  });
  const [confirm, setConfirm] = React.useState<Confirm>(null);
  const [catchup, setCatchup] = React.useState(false);
  const eventsRef = React.useRef(events);
  eventsRef.current = events;

  const send = React.useCallback(
    (content: string) => sendAsync({ content, targetChannel: channel }),
    [channel, sendAsync],
  );

  const requestListing = React.useCallback(async () => {
    const fresh = findFreshListing(
      eventsRef.current,
      channel,
      agentPubkey,
      Math.floor(Date.now() / 1_000),
    );
    if (fresh) {
      dispatch({ type: "show-listing", listingEventId: fresh.eventId });
      return;
    }
    dispatch({ type: "request-started" });
    try {
      const sent = await send(SESSIONS_LIST_COMMAND);
      dispatch({
        type: "request-sent",
        request: { eventId: sent.id, sentAt: sent.created_at },
      });
    } catch (error) {
      dispatch({
        type: "request-failed",
        message:
          error instanceof Error ? error.message : "Could not ask the agent.",
      });
    }
  }, [agentPubkey, channel, send]);

  const waitingRequest = state.status === "waiting" ? state.request : null;
  React.useEffect(() => {
    if (!waitingRequest) return;
    const reply = findListingReply(
      events,
      channel,
      agentPubkey,
      waitingRequest,
    );
    if (reply) {
      dispatch({
        type: "listing-arrived",
        listingEventId: reply.eventId,
        requestId: waitingRequest.eventId,
      });
    }
  }, [agentPubkey, channel, events, waitingRequest]);

  React.useEffect(() => {
    if (!waitingRequest) return;
    const timer = window.setTimeout(() => {
      dispatch({ type: "timed-out", requestId: waitingRequest.eventId });
    }, LISTING_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [waitingRequest]);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) void requestListing();
    else dispatch({ type: "reset" });
  };

  const listing = React.useMemo(() => {
    if (state.status !== "ready") return null;
    const event = events.find(
      (candidate) => candidate.id === state.listingEventId,
    );
    return event ? parseSessionsListing(event.tags) : null;
  }, [events, state]);

  const runCommand = async (content: string) => {
    setConfirm(null);
    try {
      await send(content);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not reach the agent.",
      );
    }
  };

  const askConfirm = (next: Confirm) => {
    setCatchup(false);
    setOpen(false);
    dispatch({ type: "reset" });
    setConfirm(next);
  };

  return (
    <>
      <Popover onOpenChange={onOpenChange} open={open}>
        <PopoverTrigger asChild>
          <Button
            aria-label="Sessions"
            data-testid="agent-sessions-picker-trigger"
            size="icon"
            title="Sessions"
            type="button"
            variant="outline"
          >
            <History aria-hidden />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          aria-label="Sessions"
          className="w-80 p-3"
          data-testid="agent-sessions-picker"
        >
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">Sessions</h3>
            <Button
              onClick={() => askConfirm({ kind: "new" })}
              size="xs"
              type="button"
              variant="outline"
            >
              <Plus aria-hidden />
              New session
            </Button>
          </div>
          <div aria-live="polite" className="mt-2" role="status">
            {state.status === "requesting" || state.status === "waiting" ? (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <LoaderCircle
                  aria-hidden
                  className="h-3.5 w-3.5 animate-spin"
                />
                Asking the agent for its sessions…
              </p>
            ) : null}
            {state.status === "timeout" || state.status === "error" ? (
              <div className="flex flex-col items-start gap-2">
                <p className="text-xs text-muted-foreground">
                  {state.status === "timeout"
                    ? AGENT_DID_NOT_ANSWER
                    : state.message}
                </p>
                <Button
                  onClick={() => void requestListing()}
                  size="xs"
                  type="button"
                  variant="outline"
                >
                  Try again
                </Button>
              </div>
            ) : null}
            {state.status === "ready" && listing?.items.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No earlier sessions yet.
              </p>
            ) : null}
          </div>
          {state.status === "ready" && listing && listing.items.length > 0 ? (
            <ul className="mt-1 flex max-h-80 flex-col gap-1 overflow-y-auto">
              {listing.items.map((item) => {
                const title = sessionItemTitle(item);
                return (
                  <li
                    className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-muted/50"
                    key={item.sessionId}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5 text-sm">
                        <span className="truncate">{title}</span>
                        {item.current ? (
                          <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-2xs font-medium text-primary">
                            Current
                          </span>
                        ) : null}
                      </p>
                      <p className="text-2xs text-muted-foreground">
                        {sessionItemCaption(item)}
                      </p>
                    </div>
                    <Button
                      aria-label={`Load session ${title}`}
                      disabled={!item.loadable}
                      onClick={() => askConfirm({ kind: "load", item })}
                      size="xs"
                      title={item.loadable ? undefined : "Can't be loaded"}
                      type="button"
                      variant="outline"
                    >
                      Load
                    </Button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </PopoverContent>
      </Popover>
      <AlertDialog
        onOpenChange={(next) => {
          if (!next) setConfirm(null);
        }}
        open={confirm !== null}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.kind === "load"
                ? "Load this session?"
                : "Start a new session?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.kind === "load"
                ? `The agent resumes "${sessionItemTitle(confirm.item)}" as it was. Your next message continues there.`
                : "The agent ends its current session. Your next message starts a fresh one."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirm?.kind === "load" ? (
            <div className="flex items-center gap-2">
              <Checkbox
                checked={catchup}
                id="agent-session-load-catchup"
                onCheckedChange={(checked) => setCatchup(checked === true)}
              />
              <label className="text-sm" htmlFor="agent-session-load-catchup">
                Include catch-up note
              </label>
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!confirm) return;
                void runCommand(
                  confirm.kind === "load"
                    ? loadSessionCommand(confirm.item.sessionId, catchup)
                    : NEW_SESSION_COMMAND,
                );
              }}
            >
              {confirm?.kind === "load" ? "Load session" : "New session"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
