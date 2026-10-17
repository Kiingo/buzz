import { useChannelsQuery } from "@/features/channels/hooks";
import {
  SettingsOptionGroup,
  SettingsOptionGroupList,
  SettingsOptionRow,
} from "@/features/settings/ui/SettingsOptionGroup";
import { SettingsSectionHeader } from "@/features/settings/ui/SettingsSectionHeader";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Switch } from "@/shared/ui/switch";

import type { RemoteSignerLogEntry } from "../lib/api";
import {
  MASTER_SWITCH_LABEL,
  SETTINGS_SECTION_LABEL,
  SIGNER_SERVICE_NAME,
  channelName,
  decisionLabel,
  logActionLabel,
  outcomeLabel,
  remainingLabel,
  scopeLabel,
  shortEventId,
  statusLabel,
} from "../lib/display";
import {
  useNow,
  useRemoteSignerSnapshot,
  useRevokeRemoteSignerScopes,
  useSetRemoteSignerEnabled,
} from "../useRemoteSigner";

const timeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "short",
  timeStyle: "medium",
});

function LogRow({
  entry,
  label,
}: {
  entry: RemoteSignerLogEntry;
  label: string;
}) {
  const good = entry.outcome === "signed";
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 px-4 py-2 text-sm">
      <span className="min-w-0 truncate">
        <span className="font-medium">{logActionLabel(entry.action)}</span>
        <span className="text-muted-foreground"> · {label}</span>
      </span>
      <span
        className={cn(
          "text-right text-xs font-medium",
          good
            ? "text-emerald-600 dark:text-emerald-400"
            : "text-muted-foreground",
        )}
      >
        {outcomeLabel(entry)}
      </span>
      <span className="min-w-0 truncate text-xs text-muted-foreground">
        {timeFormat.format(entry.at)} · {decisionLabel(entry)}
        {entry.detail ? ` · ${entry.detail}` : ""}
      </span>
      <span className="text-right font-mono text-xs text-muted-foreground">
        {entry.eventId ? shortEventId(entry.eventId) : ""}
      </span>
    </li>
  );
}

/** Settings → Kiingo signing: master switch, active scopes and signing log. */
export function RemoteSignerSettingsCard() {
  const snapshotQuery = useRemoteSignerSnapshot();
  const setEnabled = useSetRemoteSignerEnabled();
  const revoke = useRevokeRemoteSignerScopes();
  const channels = useChannelsQuery();
  const snapshot = snapshotQuery.data;
  const now = useNow(Boolean(snapshot?.scopes.length));
  const self = snapshot?.signerPubkey ?? null;

  return (
    <section className="min-w-0" data-testid="settings-remote-signing">
      <SettingsSectionHeader
        title={SETTINGS_SECTION_LABEL}
        description={
          <>
            Lets {SIGNER_SERVICE_NAME} ask this device to post or read as you
            while Buzz is running. Your key never leaves this device: each
            request is checked here and needs your approval, or a scope you
            created. Scopes and this log are stored only on this device.
          </>
        }
      />
      {!snapshot ? (
        <p className="text-sm text-muted-foreground">
          {snapshotQuery.isError
            ? `${SETTINGS_SECTION_LABEL} isn't available here.`
            : "Loading…"}
        </p>
      ) : !snapshot.available ? (
        <p className="text-sm text-muted-foreground">
          {SETTINGS_SECTION_LABEL} isn't available in this build.
        </p>
      ) : (
        <SettingsOptionGroupList>
          <SettingsOptionGroup title="Requests">
            <SettingsOptionRow>
              <div className="min-w-0">
                <label
                  className="text-sm font-medium"
                  htmlFor="remote-signer-switch"
                >
                  {MASTER_SWITCH_LABEL}
                </label>
                <p
                  className="text-sm font-normal text-muted-foreground/70"
                  data-settings-subcopy
                >
                  Off by default, for this device and community only.{" "}
                  {snapshot.enabled
                    ? statusLabel(snapshot.status, snapshot.lastError)
                    : "Requests fail until you turn this on."}
                </p>
              </div>
              <Switch
                checked={snapshot.enabled}
                data-testid="remote-signer-toggle"
                disabled={setEnabled.isPending}
                id="remote-signer-switch"
                onCheckedChange={(checked) => setEnabled.mutate(checked)}
              />
            </SettingsOptionRow>
            {setEnabled.error ? (
              <SettingsOptionRow>
                <p className="text-sm text-destructive" role="alert">
                  {setEnabled.error instanceof Error
                    ? setEnabled.error.message
                    : "Couldn't change this setting."}
                </p>
              </SettingsOptionRow>
            ) : null}
          </SettingsOptionGroup>

          <SettingsOptionGroup
            data-testid="remote-signer-scopes"
            description="Each scope signs matching requests without asking until it expires."
            headerAction={
              snapshot.scopes.length > 0 ? (
                <Button
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate(undefined)}
                  size="xs"
                  type="button"
                  variant="outline"
                >
                  Revoke all
                </Button>
              ) : null
            }
            title="Active scopes"
          >
            {snapshot.scopes.length === 0 ? (
              <SettingsOptionRow>
                <p className="text-sm text-muted-foreground">
                  No active scopes. Every request asks you first.
                </p>
              </SettingsOptionRow>
            ) : (
              snapshot.scopes.map((scope) => (
                <SettingsOptionRow key={scope.id}>
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {scopeLabel(scope, channels.data, self)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {remainingLabel(scope.expiresAt, now)}
                    </p>
                  </div>
                  <Button
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate(scope.id)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    Revoke
                  </Button>
                </SettingsOptionRow>
              ))
            )}
          </SettingsOptionGroup>

          <SettingsOptionGroup
            data-testid="remote-signer-log"
            description="Time, action, channel, how it was decided and the published event id. No signatures are kept."
            title="Signing log"
          >
            {snapshot.log.length === 0 ? (
              <SettingsOptionRow>
                <p className="text-sm text-muted-foreground">
                  Nothing has been requested on this device yet.
                </p>
              </SettingsOptionRow>
            ) : (
              <ul className="divide-y divide-border/55">
                {snapshot.log.map((entry, index) => (
                  <LogRow
                    entry={entry}
                    key={`${entry.at}:${entry.requestId ?? index}`}
                    label={
                      entry.channelId
                        ? channelName(entry.channelId, channels.data, self)
                        : "No channel"
                    }
                  />
                ))}
              </ul>
            )}
          </SettingsOptionGroup>
        </SettingsOptionGroupList>
      )}
    </section>
  );
}
