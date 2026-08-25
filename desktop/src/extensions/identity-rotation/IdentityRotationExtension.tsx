import * as React from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  CheckCircle2,
  KeyRound,
  LoaderCircle,
  ShieldAlert,
} from "lucide-react";

import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";

type PublicHandoff = {
  id: string;
  contractVersion: number;
  rotationId: string;
  resume: boolean;
  recoveryBackupRequired: boolean;
  assistedReminder: boolean;
};

type RotationPreview = {
  mode: "human" | "agent" | "all";
  managedAgentCount: number;
  hostedAgentCount: number;
  agentNames: string[];
  recoveryBackupRequired: boolean;
};

type RotationProgress = {
  rotationId: string;
  state: string;
  message: string;
  terminal: boolean;
  errorCode?: string | null;
};

const INITIAL_MESSAGE =
  "Buzz will verify a recovery backup, stage replacement identities in secure storage, preserve continuity, test hosted agents, and only then revoke old authority.";

const safeErrorCode = (value: unknown): string | null =>
  typeof value === "string" &&
  /^(?:buzz_)?identity_rotation_[a-z0-9_]{1,80}$/.test(value)
    ? value
    : null;

const safeProgress = (value: RotationProgress): RotationProgress => {
  const hasControlCharacter =
    typeof value.message === "string" &&
    Array.from(value.message).some((character) => character.charCodeAt(0) < 32);
  const message =
    typeof value.message === "string" &&
    value.message.length <= 320 &&
    !hasControlCharacter &&
    !/nsec1|ncryptsec1|private_key|resume_token|password|ciphertext/i.test(
      value.message,
    )
      ? value.message
      : "Identity rotation status updated.";
  const errorCode = safeErrorCode(value.errorCode);
  const actionableMessage = errorCode
    ? ROTATION_ERROR_MESSAGES[errorCode]
    : undefined;
  return { ...value, message: actionableMessage ?? message, errorCode };
};

const ROTATION_ERROR_MESSAGES: Record<string, string> = {
  identity_rotation_backup_file_exists:
    "That backup filename already exists. Choose a different filename so Buzz never overwrites an existing recovery backup.",
  identity_rotation_old_membership_missing:
    "Buzz could not verify the source relay membership. Your old keys remain active; install the latest Buzz update and resume this same rotation.",
  identity_rotation_membership_controller_timeout:
    "Kiingo could not copy the replacement relay memberships in time. Your old keys remain active; contact Kiingo support before resuming.",
  identity_rotation_relay_membership_role_conflict:
    "A replacement identity already has a different relay role. Your old keys remain active; Kiingo must reconcile the conflicting role before you resume.",
  identity_rotation_channel_membership_role_conflict:
    "A replacement identity already has a different channel role. Your old keys remain active; reconcile that role before resuming.",
  identity_rotation_channel_owner_handoff_failed:
    "Buzz could not transfer a channel's final owner role to the replacement identity. The prior authority has not been purged. Reconcile that channel owner, then resume this same rotation.",
  identity_rotation_old_channel_revocation_failed:
    "Buzz could not remove a prior identity from one of its channels after verifying the replacement role. The prior authority has not been purged. Contact Kiingo support before resuming this same rotation.",
  identity_rotation_relay_membership_admin_required:
    "This relay membership change requires the Kiingo membership controller. Your old keys remain active; update Buzz and resume after the controller is available.",
  identity_rotation_relay_owner_transfer_required:
    "The relay owner identity needs an operator-assisted ownership transfer. Your old keys remain active; contact Kiingo support before resuming.",
  identity_rotation_relay_unreachable:
    "Buzz could not reach the relay while verifying the cutover. The prior authority has not been purged. Check connectivity, then resume this same rotation.",
  identity_rotation_archive_source_authority_unavailable:
    "The prior identity is not yet available to sign its archival record. The prior authority has not been purged. Wait for relay membership reconciliation, then resume this same rotation.",
  identity_rotation_archive_publish_failed:
    "Buzz could not publish a retired-identity archive record. The prior authority has not been purged. Install the latest Buzz update, then resume this same rotation.",
  identity_rotation_archive_verification_failed:
    "Buzz published a retired-identity archive request but could not verify the relay's canonical archive snapshot. The prior authority has not been purged. Resume this same rotation after relay connectivity is stable.",
  identity_rotation_archive_lineage_missing:
    "The relay archive snapshot does not contain the expected replacement pointer. The prior authority has not been purged. Contact Kiingo support before resuming this same rotation.",
  identity_rotation_archive_lineage_invalid:
    "The relay returned an invalid signed archive lineage. The prior authority has not been purged. Contact Kiingo support before resuming this same rotation.",
  identity_rotation_revocation_verification_unavailable:
    "Buzz could not obtain explicit proof that every prior identity is denied. It did not treat the failed check as revocation evidence. Check relay health, then resume this same rotation.",
  identity_rotation_hosted_inventory_conflict:
    "Buzz found a mismatch between the signed hosted-agent inventory and this device. No identities were changed; ask Kiingo support to reconcile the inventory before resuming this same rotation.",
  identity_rotation_postcommit_hosted_inventory_conflict:
    "Your replacement identity is already active on this device, but Buzz could not verify its hosted deployment lineage. The prior authority has not been purged. Do not start another rotation; update Buzz and resume this same rotation.",
  identity_rotation_owner_canary_failed:
    "Your replacement identity is active locally, but its signed relay canary failed. The prior authority has not been purged. Check relay connectivity, then resume this same rotation.",
  identity_rotation_hosted_canary_failed:
    "Your replacement identity is active locally, but a hosted-agent canary could not run. The prior authority has not been purged. Ask Kiingo support to check hosted capacity, then resume this same rotation.",
  identity_rotation_hosted_canary_timeout:
    "Your replacement identity is active locally, but a hosted agent did not answer its private canary in time. The prior authority has not been purged. Check hosted capacity, then resume this same rotation.",
  identity_rotation_coordinator_recoverable:
    "The coordinator paused at a durable checkpoint without a specific public error. Your old keys remain active; request a fresh resume link after Kiingo checks the coordinator.",
  identity_rotation_unexpected_final_state:
    "Buzz could not confirm the coordinator's final state. Your old keys remain active; do not start another rotation. Contact Kiingo support so this rotation can be verified and resumed safely.",
  identity_rotation_internal:
    "Buzz encountered an unexpected error before cutover. Your old keys remain active; install the latest Buzz update and resume this same rotation. If it repeats, contact Kiingo support with the support code below.",
  identity_rotation_postcommit_internal:
    "Buzz encountered an unexpected error after committing the replacement identity locally. The prior authority has not been purged. Do not start another rotation; install the latest Buzz update and resume this same rotation.",
};

export function IdentityRotationExtension() {
  const [handoff, setHandoff] = React.useState<PublicHandoff | null>(null);
  const [confirmed, setConfirmed] = React.useState(false);
  const [passphrase, setPassphrase] = React.useState("");
  const [passphraseAgain, setPassphraseAgain] = React.useState("");
  const [running, setRunning] = React.useState(false);
  const [recoveryBackupRequired, setRecoveryBackupRequired] =
    React.useState(true);
  const [progress, setProgress] = React.useState<RotationProgress | null>(null);
  const [preview, setPreview] = React.useState<RotationPreview | null>(null);

  React.useEffect(() => {
    let disposed = false;
    const inspect = (pending: PublicHandoff) => {
      setPreview(null);
      setRecoveryBackupRequired(true);
      void invoke<RotationPreview>("inspect_identity_rotation_handoff", {
        id: pending.id,
      })
        .then((value) => {
          if (!disposed) {
            setPreview(value);
            setRecoveryBackupRequired(value.recoveryBackupRequired);
          }
        })
        .catch((error) => {
          if (!disposed) {
            setProgress(
              safeProgress({
                rotationId: pending.rotationId,
                state: "failed",
                message:
                  "Buzz could not verify this rotation plan. Return to your identity security settings and request a fresh handoff or resume link.",
                terminal: true,
                errorCode:
                  safeErrorCode(error) ?? "identity_rotation_preview_failed",
              }),
            );
          }
        });
    };
    void invoke<PublicHandoff | null>("take_pending_identity_rotation").then(
      (pending) => {
        if (!disposed && pending) {
          setHandoff(pending);
          inspect(pending);
        }
      },
    );
    const unlisten = listen<PublicHandoff>(
      "deep-link-identity-rotation",
      ({ payload }) => {
        if (!disposed) {
          setHandoff(payload);
          setProgress(null);
          setPreview(null);
          setConfirmed(false);
          setPassphrase("");
          setPassphraseAgain("");
          inspect(payload);
        }
      },
    );
    const unlistenProgress = listen<RotationProgress>(
      "identity-rotation-progress",
      ({ payload }) => {
        if (!disposed) setProgress(safeProgress(payload));
      },
    );
    return () => {
      disposed = true;
      void unlisten.then((stop) => stop());
      void unlistenProgress.then((stop) => stop());
    };
  }, []);

  const passphraseValid =
    !recoveryBackupRequired ||
    (passphrase.length >= 12 && passphrase === passphraseAgain);
  const complete = progress?.state === "complete";
  const scopeSummary = preview
    ? preview.mode === "human"
      ? "your human Buzz identity"
      : preview.mode === "agent"
        ? `one managed agent${preview.agentNames[0] ? ` (${preview.agentNames[0]})` : ""}`
        : `your human identity and ${preview.managedAgentCount} managed agent${preview.managedAgentCount === 1 ? "" : "s"}`
    : "the signed rotation scope";

  const close = React.useCallback(async () => {
    if (running || !handoff) return;
    if (complete) {
      await invoke("acknowledge_pending_identity_rotation", {
        id: handoff.id,
      });
    }
    setHandoff(null);
    setPassphrase("");
    setPassphraseAgain("");
  }, [complete, handoff, running]);

  const start = React.useCallback(async () => {
    if (!handoff || !preview || !confirmed || !passphraseValid || running)
      return;
    setRunning(true);
    setProgress({
      rotationId: handoff.rotationId,
      state: "starting",
      message: "Verifying the signed rotation plan…",
      terminal: false,
    });
    try {
      await invoke("run_identity_rotation", {
        request: {
          handoffId: handoff.id,
          recoveryPassphrase: recoveryBackupRequired ? passphrase : null,
        },
      });
    } catch (error) {
      setProgress((current) => {
        if (current?.terminal && current.errorCode) return current;
        return safeProgress({
          rotationId: handoff.rotationId,
          state: "recoverable",
          message:
            current?.message ??
            "Rotation paused safely. Resolve the issue and open the rotation link again to resume.",
          terminal: true,
          errorCode: safeErrorCode(error) ?? "identity_rotation_failed",
        });
      });
    } finally {
      setPassphrase("");
      setPassphraseAgain("");
      setRunning(false);
    }
  }, [
    confirmed,
    handoff,
    passphrase,
    passphraseValid,
    preview,
    recoveryBackupRequired,
    running,
  ]);

  return (
    <Dialog
      open={Boolean(handoff)}
      onOpenChange={(open) => !open && void close()}
    >
      <DialogContent
        aria-describedby="identity-rotation-description"
        className="max-w-xl"
        onEscapeKeyDown={(event) => running && event.preventDefault()}
        onInteractOutside={(event) => running && event.preventDefault()}
        showCloseButton={!running}
      >
        <DialogHeader>
          <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
            {complete ? (
              <CheckCircle2 aria-hidden="true" />
            ) : progress?.terminal ? (
              <ShieldAlert aria-hidden="true" />
            ) : (
              <KeyRound aria-hidden="true" />
            )}
          </div>
          <DialogTitle>Rotate Buzz identity keys</DialogTitle>
          <DialogDescription id="identity-rotation-description">
            {handoff?.assistedReminder
              ? `Your assisted key-rotation reminder is due. ${INITIAL_MESSAGE}`
              : INITIAL_MESSAGE}
          </DialogDescription>
        </DialogHeader>

        {progress ? (
          <div
            aria-live="polite"
            className="rounded-xl border border-border/60 bg-muted/40 p-4"
            role="status"
          >
            <div className="flex items-start gap-3">
              {!progress.terminal ? (
                <LoaderCircle
                  aria-hidden="true"
                  className="mt-0.5 h-5 w-5 animate-spin text-primary"
                />
              ) : null}
              <div className="min-w-0">
                <p className="text-sm font-medium">{progress.message}</p>
                {progress.errorCode ? (
                  <p className="mt-2 break-all font-mono text-xs text-destructive">
                    Support code: {progress.errorCode}
                  </p>
                ) : null}
              </div>
            </div>
          </div>
        ) : preview ? (
          <div className="space-y-4">
            <section
              aria-label="Verified rotation scope"
              className="rounded-xl border border-primary/30 bg-primary/5 p-4 text-sm"
            >
              <p className="font-medium text-foreground">
                This hard cutover will rotate {scopeSummary}.
              </p>
              <p className="mt-1 text-muted-foreground">
                {preview.hostedAgentCount} hosted and{" "}
                {preview.managedAgentCount - preview.hostedAgentCount} local
                agent identities are included.
              </p>
            </section>
            <div className="rounded-xl border border-border/60 p-4 text-sm text-muted-foreground">
              <p className="font-medium text-foreground">Before cutover</p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                <li>
                  A native save dialog creates your encrypted NIP-49 backup.
                </li>
                <li>
                  No private key or passphrase is sent to the coordinator.
                </li>
                <li>
                  Old authority remains active until continuity and hosted
                  capacity verify.
                </li>
              </ul>
            </div>
            {recoveryBackupRequired ? (
              <>
                <label
                  className="grid gap-1.5 text-sm"
                  htmlFor="rotation-passphrase"
                >
                  <span className="font-medium">
                    Recovery backup passphrase
                  </span>
                  <Input
                    autoComplete="new-password"
                    id="rotation-passphrase"
                    minLength={12}
                    onChange={(event) => setPassphrase(event.target.value)}
                    type="password"
                    value={passphrase}
                  />
                  <span className="text-xs text-muted-foreground">
                    At least 12 characters. Buzz does not save it.
                  </span>
                </label>
                <label
                  className="grid gap-1.5 text-sm"
                  htmlFor="rotation-passphrase-confirm"
                >
                  <span className="font-medium">Confirm passphrase</span>
                  <Input
                    autoComplete="new-password"
                    id="rotation-passphrase-confirm"
                    onChange={(event) => setPassphraseAgain(event.target.value)}
                    type="password"
                    value={passphraseAgain}
                  />
                  {passphraseAgain && passphrase !== passphraseAgain ? (
                    <span className="text-xs text-destructive">
                      Passphrases do not match.
                    </span>
                  ) : null}
                </label>
              </>
            ) : (
              <div className="rounded-lg border border-border/60 p-3 text-sm text-muted-foreground">
                The required human recovery backup was already verified, or this
                rotation changes only an agent identity.
              </div>
            )}
            <label className="flex items-start gap-3 rounded-lg p-1 text-sm">
              <input
                checked={confirmed}
                className="mt-0.5 h-4 w-4"
                onChange={(event) => setConfirmed(event.target.checked)}
                type="checkbox"
              />
              <span>
                I understand this is a hard cutover after verification and that
                the prior authority for {scopeSummary} will be revoked after
                continuity and live canaries pass.
              </span>
            </label>
          </div>
        ) : (
          <div
            aria-live="polite"
            className="flex items-center gap-3 rounded-xl border border-border/60 bg-muted/40 p-4 text-sm"
            role="status"
          >
            <LoaderCircle
              aria-hidden="true"
              className="h-5 w-5 animate-spin text-primary"
            />
            Verifying the signed scope and local managed-agent inventory…
          </div>
        )}

        <DialogFooter>
          {complete || progress?.terminal ? (
            <Button onClick={() => void close()} type="button">
              {complete ? "Done" : "Close"}
            </Button>
          ) : (
            <>
              <Button
                disabled={running}
                onClick={() => void close()}
                type="button"
                variant="outline"
              >
                Not now
              </Button>
              <Button
                disabled={!preview || !confirmed || !passphraseValid || running}
                onClick={() => void start()}
                type="button"
              >
                {running
                  ? handoff?.resume
                    ? "Resuming…"
                    : "Rotating…"
                  : handoff?.resume
                    ? "Resume rotation"
                    : "Verify backup and rotate"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
