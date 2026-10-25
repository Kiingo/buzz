// Generated from the Kiingo surface renderer packages; do not edit here.
import { useId } from "react";
import {
  acceptsTaps,
  MAX_ACTIONS,
  plainText,
  RUN_UNAVAILABLE_HINT,
  RUN_UNAVAILABLE_TEXT,
  type ActionStyle,
  type Pointer,
  type SurfaceAction,
} from "../core";
import { cn } from "./cn";
import { useNodeContext, type NodeProps } from "./context";
import { catalogIcon } from "./icons";
import { Spinner, SurfaceButton, SurfaceMenu } from "./ui";

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

export const ActionButton = ({
  action,
  scope,
  label,
  style,
  icon,
  fullWidth,
}: {
  action: SurfaceAction;
  scope: Pointer;
  label?: string;
  style?: ActionStyle;
  icon?: string;
  fullWidth?: boolean;
}) => {
  const context = useNodeContext();
  const hintId = useId();
  const text = label ?? action.label;
  const busy = context.snapshot.busyActionId === action.id;
  const runOff = action.kind === "run" && !context.controller.runAvailable;
  const iconName = icon ?? action.icon;
  const Icon = iconName ? catalogIcon(iconName) : undefined;
  const button = (
    <SurfaceButton
      variant={style ?? action.style}
      fullWidth={fullWidth}
      disabled={!context.canTap(action) || context.busy}
      aria-busy={busy || undefined}
      aria-describedby={runOff ? hintId : undefined}
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
  if (!runOff) {
    return button;
  }
  return (
    <span className={cn("inline-flex flex-col gap-0.5", fullWidth && "w-full")}>
      {button}
      <span id={hintId} className="text-xs text-muted-foreground">
        {RUN_UNAVAILABLE_TEXT}
      </span>
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
        return {
          key: action.id,
          label: runOff
            ? `${action.label} (${RUN_UNAVAILABLE_TEXT})`
            : action.label,
          destructive: action.style === "destructive",
          disabled: !context.canTap(action),
          hint: runOff ? RUN_UNAVAILABLE_HINT : undefined,
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
  const shown = ordered.length > 4 ? ordered.slice(0, 3) : ordered;
  const more = ordered.length > 4 ? ordered.slice(3) : [];
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

/** `chips: [{text, label?}]`: a tap sends `text` as the user's message. */
export const SuggestionChipsView = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  const send = context.host.sendMessage;
  const chips = context.list(component, "chips", scope).slice(0, 6);
  return (
    <div className="flex flex-wrap gap-1.5">
      {chips.map((chip, index) => {
        const record =
          typeof chip === "object" && chip !== null && !Array.isArray(chip)
            ? chip
            : {};
        const text = plainText(
          (record as Record<string, unknown>).text,
          300,
          true,
        );
        if (!text) {
          return null;
        }
        const label =
          plainText((record as Record<string, unknown>).label, 80) ?? text;
        return (
          <button
            key={index}
            type="button"
            disabled={!send || !acceptsTaps(context.surface)}
            title="Sends this as your message"
            onClick={() => send?.(text)}
            className={cn(
              "rounded-full border border-border bg-background px-3 py-1 text-xs text-foreground hover:bg-muted",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
};

/** `{text, action}`: link-styled text that performs the action (R10 for `open`). */
export const LinkView = ({ component, scope }: NodeProps) => {
  const context = useNodeContext();
  const label = context.text(component, "text", scope, 200);
  const action = context.action(component.props.action);
  if (!action) {
    return label ? <span className="text-sm">{label}</span> : null;
  }
  return (
    <button
      type="button"
      disabled={!context.canTap(action) || context.busy}
      onClick={() => context.perform(action.id, scope)}
      className="text-left text-sm text-primary underline-offset-2 hover:underline disabled:opacity-50"
    >
      {label ?? action.label}
    </button>
  );
};
