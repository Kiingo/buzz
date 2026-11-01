import * as React from "react";

import { useUpdateChannelMutation } from "@/features/channels/hooks";
import type { Channel } from "@/shared/api/types";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";

/**
 * Rename a channel from its right-click menu (Ross 2026-10-31: rename a
 * chat or channel wherever it is listed). Saves the trimmed name through the
 * same update the Channel Settings editor uses; the relay keeps its own rules
 * on who may rename.
 */
export function useRenameChannelDialog() {
  const [target, setTarget] = React.useState<Channel | null>(null);
  const [name, setName] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);
  const updateChannel = useUpdateChannelMutation(target?.id ?? null);

  const requestRenameChannel = React.useCallback((channel: Channel) => {
    setName(channel.name);
    setTarget(channel);
  }, []);

  const open = target !== null;
  React.useEffect(() => {
    if (!open) return;
    // Let the dialog animation start before focusing, as the section dialogs do.
    const timerId = globalThis.setTimeout(() => {
      inputRef.current?.select();
    }, 50);
    return () => globalThis.clearTimeout(timerId);
  }, [open]);

  const trimmed = name.trim();
  const unchanged = trimmed === (target?.name.trim() ?? "");
  const disabled = trimmed.length === 0 || unchanged || updateChannel.isPending;

  function close() {
    updateChannel.reset();
    setTarget(null);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;
    try {
      await updateChannel.mutateAsync({ name: trimmed });
      setTarget(null);
    } catch {
      // React Query keeps the error; the dialog stays open and shows it.
    }
  }

  const dialog = (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Rename channel</DialogTitle>
          <DialogDescription>
            Enter a new name for this channel.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <Input
            autoComplete="off"
            data-testid="rename-channel-name"
            onChange={(event) => setName(event.target.value)}
            placeholder="Channel name"
            ref={inputRef}
            spellCheck={false}
            value={name}
          />
          {updateChannel.error instanceof Error ? (
            <p className="mt-2 text-sm text-destructive">
              {updateChannel.error.message}
            </p>
          ) : null}
          <div className="mt-4 flex justify-end gap-2">
            <DialogClose asChild>
              <Button type="button" variant="ghost">
                Cancel
              </Button>
            </DialogClose>
            <Button disabled={disabled} type="submit">
              {updateChannel.isPending ? "Saving..." : "Save"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );

  return { requestRenameChannel, dialog };
}
