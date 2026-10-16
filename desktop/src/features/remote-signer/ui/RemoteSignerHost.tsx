import {
  useRemoteSignerEvents,
  useRemoteSignerSnapshot,
} from "../useRemoteSigner";
import { RemoteSignerPromptDialog } from "./RemoteSignerPromptDialog";
import { RemoteSignerScopePill } from "./RemoteSignerScopePill";

/**
 * Global remote-signer surfaces: the consent prompt and the active-scope
 * indicator. Reading the snapshot also lets the backend start its poller
 * when the switch is on. Renders nothing in builds without a signer.
 */
export function RemoteSignerHost() {
  useRemoteSignerEvents();
  const snapshot = useRemoteSignerSnapshot().data;
  if (!snapshot?.available) return null;

  return (
    <>
      {snapshot.prompt ? (
        <RemoteSignerPromptDialog
          key={snapshot.prompt.requestId}
          prompt={snapshot.prompt}
          signerPubkey={snapshot.signerPubkey}
        />
      ) : null}
      <RemoteSignerScopePill
        count={snapshot.enabled ? snapshot.scopes.length : 0}
      />
    </>
  );
}
