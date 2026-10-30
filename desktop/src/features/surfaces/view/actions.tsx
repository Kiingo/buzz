// Generated from the Kiingo surface renderer packages at 31af16c4bf4bf2ccee353af7c8c836d4be5d621a; do not edit here.
import { useId } from "react";
import {
  acceptsTaps,
  chipActionId,
  chipSend,
  MAX_ACTIONS,
  messageSend,
  RUN_UNAVAILABLE_HINT,
  RUN_UNAVAILABLE_TEXT,
  sendBlockedText,
  sendsCaption,
  type ActionStyle,
  type MessageSend,
  type Pointer,
  type SurfaceAction,
} from "../core";
import { cn } from "./cn";
import { useNodeContext, type NodeProps } from "./context";
import { catalogIcon } from "./icons";
import { QuoteBox, Spinner, SurfaceButton, SurfaceMenu } from "./ui";

// §4.4 Actions. Labels are the agent's plain text; what a `run` does is
// shown only in the server's confirmation (§5). Run buttons are drawn
// disabled with "Open in the Kiingo app" while this client's run gate is
// off (RunActionGate in ../core).

const STYLES = new Set<ActionStyle>([
  "primary",
  "secondary",
  "destructive",
  "plain",
]);

/**
 * What a `send_message` control draws under its label (79 W1): the words it
 * sends, in full, when they differ from the label; the blocked line when it
 * can't send them.
 */
export const SendsLine = ({
  send,
  id,
}: {
  send: MessageSend | undefined;
  id?: string;
}) => {
  if (!send || send.kind === "label") {
    return null;
  }
  return (
    <span
      id={id}
      className="whitespace-pre-wrap break-words text-xs text-muted-foreground"
    >
      {send.kind === "sends" ? sendsCaption(send.text) : sendBlockedText(send)}
    </span>
  );
};

/** The `messageSend` of a `send_message` action, else undefined. */
export const actionSend = (
  action: SurfaceAction,
  agentName: string | undefined,
): MessageSend | undefined =>
  action.kind === "send_message"
    ? messageSend(action.label, action.text, action.hidden === true, agentName)
    : undefined;

export const ActionButton = ({
  action,
  scope,
  style,
  icon,
  fullWidth,
}: {
  action: SurfaceAction;
  scope: Pointer;
  style?: ActionStyle;
  icon?: string;
  fullWidth?: boolean;
}) => {
  const context = useNodeContext();
  const hintId = useId();
  const text = action.label;
  const busy = context.snapshot.busyActionId === action.id;
  const runOff = action.kind === "run" && !context.controller.runAvailable;
  const send = actionSend(action, context.surface.agentName);
  const caption = runOff || (send !== undefined && send.kind !== "label");
  const iconName = icon ?? action.icon;
  const Icon = iconName ? catalogIcon(iconName) : undefined;
  const button = (
    <SurfaceButton
      variant={style ?? action.style}
      fullWidth={fullWidth}
      disabled={!context.canTap(action) || context.busy}
      aria-busy={busy || undefined}
      aria-describedby={caption ? hintId : undefined}
      title={runOff ? RUN_UNAVAILABLE_HINT : undefined}
      onClick={() => context.perform(action.id, scope)}
    >
      {busy ? (
        <Spinner />
      ) : Icon ? (
        <Icon aria-hidden className="h-4 w-4" />
      ) : null}
      <span>{text}</span>
    </SurfaceButton>
  );
  if (!caption) {
    return button;
  }
  return (
    <span className={cn("inline-flex flex-col gap-0.5", fullWidth && "w-full")}>
      {button}
      {runOff ? (
        <span id={hintId} className="text-xs text-muted-foreground">
          {RUN_UNAVAILABLE_TEXT}
        </span>
      ) : (
        <SendsLine send={send} id={hintId} />
      )}
    </span>
  );
};

/** `{action, style?, icon?, fullWidth?}`: the action's label is the text. */
export const ButtonView = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  const action = context.action(component.props.action);
  if (!action) {
    return null;
  }
  const style = context.string(component, "style") as ActionStyle | undefined;
  return (
    <ActionButton
      action={action}
      scope={scope}
      style={style && STYLES.has(style) ? style : undefined}
      icon={context.string(component, "icon")}
      fullWidth={context.flag(component, "fullWidth", scope)}
    />
  );
};

const listedActions = (
  ids: unknown[],
  find: (id: unknown) => SurfaceAction | undefined,
): SurfaceAction[] =>
  ids
    .slice(0, MAX_ACTIONS)
    .map((item) =>
      find(
        typeof item === "object" && item !== null
          ? (item as { action?: unknown }).action
          : item,
      ),
    )
    .filter((action): action is SurfaceAction => Boolean(action));

const MenuOf = ({
  actions,
  scope,
  title,
}: {
  actions: SurfaceAction[];
  scope: Pointer;
  title: string;
}) => {
  const context = useNodeContext();
  return (
    <SurfaceMenu
      label={title}
      disabled={context.busy}
      entries={actions.map((action) => {
        const runOff =
          action.kind === "run" && !context.controller.runAvailable;
        // A menu row shows only its label: a send whose words differ is
        // drawn as a button outside menus, never here (79 W1).
        const send = actionSend(action, context.surface.agentName);
        const hidesWords = send !== undefined && send.kind !== "label";
        return {
          key: action.id,
          label: runOff
            ? `${action.label} (${RUN_UNAVAILABLE_TEXT})`
            : action.label,
          destructive: action.style === "destructive",
          disabled: !context.canTap(action) || hidesWords,
          hint: runOff
            ? RUN_UNAVAILABLE_HINT
            : hidesWords
              ? sendBlockedText(
                  send.kind === "blocked"
                    ? send
                    : { kind: "blocked", reason: "too_long" },
                )
              : undefined,
          onSelect: () => context.perform(action.id, scope),
        };
      })}
    />
  );
};

/** The first primary action leads; past four, the rest go in More. */
export const ActionBarView = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  const listed = listedActions(
    context.list(component, "actions", scope),
    (id) => context.action(id),
  );
  const primary = listed.find((action) => action.style === "primary");
  const ordered = primary
    ? [primary, ...listed.filter((action) => action.id !== primary.id)]
    : listed;
  // A send that shows its words stays a button: menus show labels only.
  const showsWords = (action: SurfaceAction) => {
    const send = actionSend(action, context.surface.agentName);
    return send !== undefined && send.kind === "sends";
  };
  const head = ordered.length > 4 ? ordered.slice(0, 3) : ordered;
  const tail = ordered.length > 4 ? ordered.slice(3) : [];
  const shown = [...head, ...tail.filter(showsWords)];
  const more = tail.filter((action) => !showsWords(action));
  const align = context.string(component, "align") ?? "start";
  return (
    <div
      className={cn(
        "flex flex-wrap items-start gap-2",
        align === "end" && "justify-end",
        align === "spaceBetween" && "justify-between",
      )}
    >
      {shown.map((action) => (
        <ActionButton key={action.id} action={action} scope={scope} />
      ))}
      {more.length > 0 ? (
        <MenuOf actions={more} scope={scope} title="More" />
      ) : null}
    </div>
  );
};

export const MenuView = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  const actions = listedActions(
    context.list(component, "actions", scope),
    (id) => context.action(id),
  );
  if (actions.length === 0) {
    return null;
  }
  return (
    <MenuOf
      actions={actions}
      scope={scope}
      title={context.text(component, "label", scope, 80) ?? "More"}
    />
  );
};

/**
 * `chips: [{text, label?}]`: a tap sends `text` as the user's message,
 * through the controller's single send path, and only when the chip shows
 * those words (79 W1). Chips read from outside content are quoted, never
 * tappable (W6).
 */
export const SuggestionChipsView = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  const send = context.host.sendMessage;
  const chips = context.list(component, "chips", scope).slice(0, 6);
  if (context.isUntrustedList(component.props.chips, scope)) {
    const words = chips
      .map((chip) => chipSend(chip)?.label)
      .filter((label): label is string => Boolean(label));
    return words.length > 0 ? <QuoteBox text={words.join("\n")} /> : null;
  }
  return (
    <div className="flex flex-wrap items-start gap-1.5">
      {chips.map((chip, index) => {
        const parsed = chipSend(chip, context.surface.agentName);
        if (!parsed) {
          return null;
        }
        const actionId = chipActionId(component.id, index);
        const blocked = parsed.send.kind === "blocked";
        return (
          <span key={index} className="inline-flex max-w-full flex-col gap-0.5">
            <button
              type="button"
              disabled={!send || !acceptsTaps(context.surface) || blocked}
              title="Sends this as your message"
              onClick={() => context.sendMessage(parsed.send, actionId)}
              className={cn(
                "self-start whitespace-pre-wrap break-words rounded-full border border-border bg-background px-3 py-1 text-left text-xs text-foreground hover:bg-muted",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
              )}
            >
              {parsed.label}
            </button>
            <SendsLine send={parsed.send} />
          </span>
        );
      })}
    </div>
  );
};

/**
 * `{text, action}`: link-styled text that performs the action (R10 for
 * `open`). A `send_message` Link sends only when its text is the words it
 * sends (79 W1/M1); outside-content text is quoted and never a link (W6).
 */
export const LinkView = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  const label = context.text(component, "text", scope, 200);
  const action = context.action(component.props.action);
  if (context.isUntrusted(component, "text", scope)) {
    return label ? <QuoteBox text={label} /> : null;
  }
  if (!action) {
    return label ? <span className="text-sm">{label}</span> : null;
  }
  const shown = label ?? action.label;
  const send = actionSend(action, context.surface.agentName);
  const sendsOther =
    send !== undefined && (send.kind === "blocked" || send.text !== shown);
  return (
    <button
      type="button"
      disabled={!context.canTap(action) || context.busy || sendsOther}
      title={
        sendsOther
          ? sendBlockedText({ kind: "blocked", reason: "too_long" })
          : undefined
      }
      onClick={() => context.perform(action.id, scope)}
      className="text-left text-sm text-primary underline-offset-2 hover:underline disabled:opacity-50"
    >
      {shown}
    </button>
  );
};
