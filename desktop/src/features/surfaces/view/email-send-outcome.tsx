// Generated from the Kiingo surface renderer packages at dbc93b6d803e88e782fd6dbc8d7871827f2a9f7c; do not edit here.
import { useState } from "react";
import type { SurfaceController } from "../core";
import { SurfaceButton } from "./ui";

/** The owner's explicit declaration, separate from a provider check or send. */
export const EmailSendOutcomeControls = ({
  controller,
  operationId,
  busy,
}: {
  controller: SurfaceController;
  operationId: string;
  busy: boolean;
}) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2 text-xs">
      <SurfaceButton
        variant="plain"
        className="self-start text-xs"
        disabled={busy}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? "Cancel" : "Record outcome"}
      </SurfaceButton>
      {open ? (
        <div className="flex flex-col gap-2">
          <p>Your answer updates this card. It does not send an email.</p>
          <div>
            <SurfaceButton
              variant="plain"
              disabled={busy}
              onClick={() =>
                void controller.resolveEmailSend(operationId, "sent")
              }
            >
              It went out
            </SurfaceButton>
            <p className="text-muted-foreground">Mark this card as sent.</p>
          </div>
          <div>
            <SurfaceButton
              variant="plain"
              disabled={busy}
              onClick={() =>
                void controller.resolveEmailSend(operationId, "not_sent")
              }
            >
              It didn’t go out
            </SurfaceButton>
            <p className="text-muted-foreground">
              Allow editing and sending again. Check Sent Items first to avoid
              sending a duplicate.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
};
