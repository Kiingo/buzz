import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";

import { useGuestAccessSnapshot } from "../../hooks";
import { useGuestEndpointFor } from "../../ownerQueries";
import { GuestBlocksTab } from "./GuestBlocksTab";
import { GuestDigestTab } from "./GuestDigestTab";
import { GuestGrantsTab } from "./GuestGrantsTab";
import { GuestPolicyTab } from "./GuestPolicyTab";
import { GuestRequestsTab } from "./GuestRequestsTab";
import { GuestSharedTab } from "./GuestSharedTab";
import { GuestSuggestionsTab } from "./GuestSuggestionsTab";

export type AccessTab =
  | "policy"
  | "grants"
  | "requests"
  | "blocked"
  | "shared"
  | "suggestions"
  | "digest";

const TABS: Array<{ id: AccessTab; label: string }> = [
  { id: "policy", label: "Policy" },
  { id: "grants", label: "Grants" },
  { id: "requests", label: "Requests" },
  { id: "blocked", label: "Blocked" },
  { id: "shared", label: "Shared" },
  { id: "suggestions", label: "Suggestions" },
  { id: "digest", label: "Digest" },
];

/** Agent settings → Access: everything about other people reaching this agent. */
export function AgentGuestAccessDialog({
  agentName,
  agentPubkey,
  initialTab = "policy",
  onOpenChange,
  open,
  respondTo,
}: {
  agentName: string;
  agentPubkey: string;
  initialTab?: AccessTab;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  respondTo: string | null | undefined;
}) {
  const { endpoint } = useGuestEndpointFor(agentPubkey);
  const snapshot = useGuestAccessSnapshot();
  const endpointStatus =
    snapshot.endpointStatus[agentPubkey.toLowerCase()] ?? null;
  const guestEndpointId = endpoint?.guestEndpointId ?? null;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="max-h-[85vh] max-w-2xl overflow-y-auto"
        data-testid="agent-guest-access-dialog"
      >
        <DialogHeader>
          <DialogTitle>Access to {agentName}</DialogTitle>
          <DialogDescription>
            How other people and their agents get answers from {agentName}.
            Their questions never run on your Mac.
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue={initialTab}>
          <TabsList className="flex flex-wrap">
            {TABS.map((tab) => (
              <TabsTrigger
                data-testid={`agent-guest-access-tab-${tab.id}`}
                key={tab.id}
                value={tab.id}
              >
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
          <div className="pt-4">
            <TabsContent value="policy">
              <GuestPolicyTab
                endpoint={endpoint}
                endpointStatus={endpointStatus}
                respondTo={respondTo}
              />
            </TabsContent>
            <TabsContent value="grants">
              <GuestGrantsTab guestEndpointId={guestEndpointId} />
            </TabsContent>
            <TabsContent value="requests">
              <GuestRequestsTab guestEndpointId={guestEndpointId} />
            </TabsContent>
            <TabsContent value="blocked">
              <GuestBlocksTab guestEndpointId={guestEndpointId} />
            </TabsContent>
            <TabsContent value="shared">
              <GuestSharedTab guestEndpointId={guestEndpointId} />
            </TabsContent>
            <TabsContent value="suggestions">
              <GuestSuggestionsTab guestEndpointId={guestEndpointId} />
            </TabsContent>
            <TabsContent value="digest">
              <GuestDigestTab />
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
