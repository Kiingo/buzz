import * as React from "react";

import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";

import type {
  RemoteSignerPrompt,
  ScopeChoice,
  ScopeDurationMinutes,
} from "../lib/api";
import {
  PUBLISH_SCOPE_KINDS,
  SCOPE_DURATIONS,
  publishKindLabel,
} from "../lib/display";

function DurationPicker({
  onChange,
  value,
}: {
  onChange: (minutes: ScopeDurationMinutes) => void;
  value: ScopeDurationMinutes;
}) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-xs font-medium text-muted-foreground">For</legend>
      <div className="flex gap-1.5">
        {SCOPE_DURATIONS.map((duration) => (
          <Button
            aria-pressed={value === duration.minutes}
            data-testid={`remote-signer-duration-${duration.minutes}`}
            key={duration.minutes}
            onClick={() => onChange(duration.minutes)}
            size="sm"
            type="button"
            variant={value === duration.minutes ? "default" : "outline"}
          >
            {duration.label}
          </Button>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * "Allow for…": a time-boxed scope created on this device. Publish scopes
 * cover chosen kinds in this one channel; read scopes cover this channel or
 * all channels. The requester can never create or extend one.
 */
export function ScopePicker({
  channelLabel,
  isPending,
  onCancel,
  onConfirm,
  prompt,
}: {
  channelLabel: string | null;
  isPending: boolean;
  onCancel: () => void;
  onConfirm: (choice: ScopeChoice) => void;
  prompt: RemoteSignerPrompt;
}) {
  const [minutes, setMinutes] = React.useState<ScopeDurationMinutes>(15);
  const [kinds, setKinds] = React.useState<number[]>(
    prompt.kind === null ? [] : [prompt.kind],
  );
  const [allChannels, setAllChannels] = React.useState(
    prompt.method === "read" && !prompt.channelId,
  );

  const isRead = prompt.method === "read";
  const canScope = isRead || Boolean(prompt.channelId);

  if (!canScope) {
    return (
      <div className="space-y-2 rounded-lg border border-border/70 p-3 text-sm">
        <p className="text-muted-foreground">
          This request isn't bound to a channel, so it can only be allowed once.
        </p>
        <Button onClick={onCancel} size="sm" type="button" variant="ghost">
          Back
        </Button>
      </div>
    );
  }

  return (
    <div
      className="space-y-3 rounded-lg border border-border/70 p-3 text-sm"
      data-testid="remote-signer-scope-picker"
    >
      {isRead ? (
        <fieldset className="space-y-1.5">
          <legend className="text-xs font-medium text-muted-foreground">
            Allow reads in
          </legend>
          <div className="flex flex-wrap gap-1.5">
            <Button
              aria-pressed={!allChannels}
              disabled={!prompt.channelId}
              onClick={() => setAllChannels(false)}
              size="sm"
              type="button"
              variant={!allChannels ? "default" : "outline"}
            >
              {channelLabel ?? "This channel"}
            </Button>
            <Button
              aria-pressed={allChannels}
              onClick={() => setAllChannels(true)}
              size="sm"
              type="button"
              variant={allChannels ? "default" : "outline"}
            >
              All my channels
            </Button>
          </div>
          {!prompt.channelId ? (
            <p className="text-xs text-muted-foreground">
              This read isn't limited to one channel, so only an all-channels
              scope can cover it.
            </p>
          ) : null}
        </fieldset>
      ) : (
        <fieldset className="space-y-1.5">
          <legend className="text-xs font-medium text-muted-foreground">
            Allow these kinds in {channelLabel ?? "this channel"}
          </legend>
          <div className="grid grid-cols-2 gap-1.5">
            {PUBLISH_SCOPE_KINDS.map((kind) => {
              const required = kind === prompt.kind;
              const checked = required || kinds.includes(kind);
              return (
                <div
                  className={cn(
                    "flex items-center gap-2",
                    required && "font-medium",
                  )}
                  key={kind}
                >
                  <Checkbox
                    checked={checked}
                    disabled={required}
                    id={`remote-signer-scope-kind-${kind}`}
                    onCheckedChange={(next) =>
                      setKinds((current) =>
                        next === true
                          ? [...new Set([...current, kind])]
                          : current.filter((value) => value !== kind),
                      )
                    }
                  />
                  <label htmlFor={`remote-signer-scope-kind-${kind}`}>
                    {publishKindLabel(kind)}
                  </label>
                </div>
              );
            })}
          </div>
        </fieldset>
      )}
      <DurationPicker onChange={setMinutes} value={minutes} />
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel} size="sm" type="button" variant="ghost">
          Back
        </Button>
        <Button
          data-testid="remote-signer-scope-confirm"
          disabled={isPending}
          onClick={() =>
            onConfirm(
              isRead
                ? { durationMinutes: minutes, allChannels }
                : { durationMinutes: minutes, kinds },
            )
          }
          size="sm"
          type="button"
        >
          Allow and create scope
        </Button>
      </div>
    </div>
  );
}
