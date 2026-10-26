// Generated from the Kiingo surface renderer packages at c72e3863b9419a77a51b527a9ff4255646c6384c; do not edit here.
import { useState, type ReactNode } from "react";
import {
  ownEntry,
  changedFlags,
  outsideLine,
  type Confirmation,
} from "../core";
import { Glyphs } from "./icons";
import { SurfaceButton, SurfaceDialog } from "./ui";

// §5 The run confirmation. Everything shown here is the server's text from
// the confirm challenge; the agent's labels never appear, so a button that
// says "Save draft" can't hide a send. The nonce goes back exactly as it came.

const ROLE_LABELS: Record<string, string> = { to: "To", cc: "Cc", bcc: "Bcc" };

export const ConfirmationDialog = ({
  confirmation,
  onConfirm,
  onCancel,
}: {
  confirmation: Confirmation;
  onConfirm: () => void;
  onCancel: () => void;
}) => {
  const [details, setDetails] = useState(false);
  const outside = outsideLine(confirmation);
  const flags = changedFlags(confirmation);
  const roles = new Map<string, Confirmation["recipients"]>();
  for (const recipient of confirmation.recipients) {
    const role =
      ownEntry(ROLE_LABELS, recipient.role.toLowerCase()) ?? "Recipients";
    roles.set(role, [...(roles.get(role) ?? []), recipient]);
  }
  const hasDetails =
    Boolean(confirmation.account) ||
    confirmation.recipients.length > 0 ||
    confirmation.attachments.length > 0 ||
    confirmation.fields.length > 0;
  return (
    <SurfaceDialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onCancel();
        }
      }}
      title="Confirm"
      description={confirmation.text}
      footer={
        <>
          <SurfaceButton onClick={onCancel}>Cancel</SurfaceButton>
          <SurfaceButton
            variant={confirmation.destructive ? "destructive" : "primary"}
            onClick={onConfirm}
          >
            {confirmation.confirmLabel || "Confirm"}
          </SurfaceButton>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="whitespace-pre-wrap text-sm">{confirmation.text}</p>
        {outside ? (
          <p className="flex items-center gap-1.5 text-sm font-medium text-amber-800 dark:text-amber-300">
            <Glyphs.globe aria-hidden className="h-4 w-4 shrink-0" />
            {outside}
          </p>
        ) : null}
        {flags.map((flag) => (
          <p
            key={flag}
            className="flex items-start gap-1.5 text-sm text-amber-800 dark:text-amber-300"
          >
            <Glyphs.warning aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
            {flag}
          </p>
        ))}
        {hasDetails ? (
          <div className="flex flex-col gap-2">
            <button
              type="button"
              aria-expanded={details}
              onClick={() => setDetails(!details)}
              className="inline-flex items-center gap-1 self-start text-sm text-primary hover:underline"
            >
              {details ? (
                <Glyphs.down aria-hidden className="h-4 w-4" />
              ) : (
                <Glyphs.right aria-hidden className="h-4 w-4" />
              )}
              Details
            </button>
            {details ? (
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
                {confirmation.account ? (
                  <>
                    <dt className="text-muted-foreground">Account</dt>
                    <dd className="break-words">{confirmation.account}</dd>
                  </>
                ) : null}
                {[...roles.entries()].map(([role, people]) => (
                  <Row key={role} label={role}>
                    {people.map((person, index) => (
                      <span key={index} className="block break-words">
                        {person.name
                          ? `${person.name} <${person.address}>`
                          : person.address}
                        {person.outside ? (
                          <span className="text-amber-800 dark:text-amber-300">
                            {" "}
                            · outside
                          </span>
                        ) : null}
                      </span>
                    ))}
                  </Row>
                ))}
                {confirmation.attachments.length > 0 ? (
                  <Row label="Attachments">
                    {confirmation.attachments.map((name, index) => (
                      <span key={index} className="block break-words">
                        {name}
                      </span>
                    ))}
                  </Row>
                ) : null}
                {confirmation.fields.map((item, index) => (
                  <Row key={`f${index}`} label={item.label}>
                    <span className="block whitespace-pre-wrap break-words">
                      {item.value}
                    </span>
                    {item.changed ? (
                      <span className="block text-xs text-amber-800 dark:text-amber-300">
                        {item.changed}
                      </span>
                    ) : null}
                  </Row>
                ))}
              </dl>
            ) : null}
          </div>
        ) : null}
      </div>
    </SurfaceDialog>
  );
};

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <>
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="min-w-0">{children}</dd>
  </>
);
