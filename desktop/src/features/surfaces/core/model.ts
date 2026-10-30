// Generated from the Kiingo surface renderer packages at ec8a842a062bf8f90327ca1b45c1fe31730d12f4; do not edit here.
import {
  asBool,
  asInt,
  asString,
  field,
  isObject,
  ownEntry,
  type JsonObject,
  type JsonValue,
} from "./json";
import { parsePointer, pointersOverlap, type Pointer } from "./pointer";
import { hasInvisibleText, openableUrl, plainId, plainText } from "./text";

// The wire model of a generative UI surface (kiingo.ui/v1,
// docs/design/generative-ui-and-mcp-core.md §3, §3.1, §4, §5, §10),
// decoded leniently like the Swift reference (UiSurface.swift): a component
// type this version doesn't know is kept and drawn as "needs a newer app",
// never a failure. Everything an agent wrote is plain text to a renderer;
// colors never come from the agent.

export const CATALOG_V1 = "kiingo.ui/v1";
export const MAX_COMPONENTS = 200;
export const MAX_DEPTH = 12;
export const MAX_ACTIONS = 20;
/** At most this many repeats are drawn (a 5,000-row list stays usable). */
export const MAX_REPEATS = 500;
/** Nodes one surface draws; past it a "too large" row (79 W8). */
export const MAX_SURFACE_NODES = 2000;
/**
 * Table cells, List rows and Chart points one surface draws, together (79
 * W6 SHOULD 5); past it the component draws a "too large" row.
 */
export const MAX_SURFACE_CELLS = 50_000;
/**
 * Diff comparison cells (tokens before x tokens after) one surface spends,
 * together (79 W6 SHOULD 5); past it a Diff shows a whole replace.
 */
export const MAX_SURFACE_DIFF_CELLS = 4_000_000;

export type SurfaceDisplay = "inline" | "expanded" | "carousel";
export type SurfaceState =
  | "active"
  | "submitted"
  | "dismissed"
  | "closed"
  | "other";
export type Tone = "default" | "muted" | "success" | "warning" | "danger";
export type StatusTone = "info" | "success" | "warning" | "danger";
export type ActorKind = "user" | "agent" | "host_app" | "member" | "system";

/** Every §4 component this version draws (catalog v1). */
export const COMPONENT_TYPES = [
  // 4.1 Layout
  "Stack",
  "Grid",
  "Section",
  "Card",
  "Tabs",
  "Accordion",
  "Carousel",
  "Steps",
  "Divider",
  "Modal",
  // 4.2 Display
  "Text",
  "Markdown",
  "Image",
  "ImageGallery",
  "Icon",
  "Badge",
  "Avatar",
  "KeyValue",
  "Table",
  "List",
  "Chart",
  "Metric",
  "Progress",
  "Timeline",
  "Code",
  "Diff",
  "Callout",
  "Quote",
  "EntityRef",
  "FileList",
  "Media",
  "LinkPreview",
  "Map",
  "Countdown",
  "LiveLog",
  "Gauge",
  "Sparkline",
  "Board",
  // 4.3 Inputs
  "TextField",
  "RichTextEditor",
  "RecipientField",
  "Select",
  "ChoicePicker",
  "Checkbox",
  "Toggle",
  "Slider",
  "Stepper",
  "DateTimeInput",
  "Rating",
  "FileInput",
  "EntityPicker",
  "Reorder",
  "TimeSlotPicker",
  "LocationPicker",
  "NumberField",
  "AddressField",
  "ColorPicker",
  // 4.4 Actions
  "Button",
  "ActionBar",
  "SuggestionChips",
  "Menu",
  "Link",
] as const;
export type ComponentType = (typeof COMPONENT_TYPES)[number];

const KNOWN_TYPES = new Set<string>(COMPONENT_TYPES);

export const INPUT_TYPES = new Set<ComponentType>([
  "TextField",
  "RichTextEditor",
  "RecipientField",
  "Select",
  "ChoicePicker",
  "Checkbox",
  "Toggle",
  "Slider",
  "Stepper",
  "DateTimeInput",
  "Rating",
  "FileInput",
  "EntityPicker",
  "Reorder",
  "TimeSlotPicker",
  "LocationPicker",
  "NumberField",
  "AddressField",
  "ColorPicker",
]);

export const isKnownType = (type: string): type is ComponentType =>
  KNOWN_TYPES.has(type);
export const isInputType = (type: string): boolean =>
  isKnownType(type) && INPUT_TYPES.has(type);

/** `visibleWhen: {path, equals | notEmpty | in, not?}`. */
export type Visibility = {
  path: string;
  test:
    | { kind: "equals"; value: JsonValue }
    | { kind: "notEmpty"; wanted: boolean }
    | { kind: "in"; values: JsonValue[] };
  negated: boolean;
};

export type SurfaceComponent = {
  id: string;
  /** The wire type, kept even when unknown. */
  type: string;
  known: boolean;
  props: JsonObject;
  visibleWhen?: Visibility;
};

export type EntityType =
  | "task"
  | "project"
  | "person"
  | "agent"
  | "email_thread"
  | "file"
  | "calendar_event"
  | "deal"
  | "company";

export const ENTITY_TYPES: readonly EntityType[] = [
  "task",
  "project",
  "person",
  "agent",
  "email_thread",
  "file",
  "calendar_event",
  "deal",
  "company",
];

export type EntityKey = { type: EntityType; id: string; title?: string };

export type ActionKind =
  | "run"
  | "ask_agent"
  | "send_message"
  | "set_state"
  | "open"
  | "dismiss"
  | "unknown";
export type ActionStyle = "primary" | "secondary" | "destructive" | "plain";
export type OpenTarget =
  | { kind: "url"; url: string }
  | { kind: "entity"; entity: EntityKey }
  | { kind: "expanded" };

export type SurfaceAction = {
  id: string;
  kind: ActionKind;
  /** The raw kind when unknown. */
  rawKind: string;
  /** Plain text; never used as a run confirmation (§5). */
  label: string;
  style: ActionStyle;
  icon?: string;
  /** send_message: the words sent as the user's message (else the label). */
  text?: string;
  /** set_state */
  statePath?: string;
  stateValue?: JsonValue;
  target?: OpenTarget;
  /** Paths checked before the action runs (else every visible input). */
  validates?: string[];
  /** run: module.method, shown nowhere (the server writes the confirmation). */
  method?: string;
  /** run: the surface stays editable after a successful run. */
  repeatable: boolean;
  /** ask_agent: the short instruction sent with the surface state. */
  prompt?: string;
  /**
   * The agent's raw label, words or prompt held an invisible character
   * (79 S1): the action never sends words (see `messageSend`).
   */
  hidden?: true;
};

export type SurfaceStatus = {
  text: string;
  tone: StatusTone;
  at?: string;
  actionId?: string;
  retryable: boolean;
};

export type SurfaceLastEdit = {
  actorKind?: ActorKind;
  actorId?: string;
  client?: string;
  at?: string;
};

export type Surface = {
  id: string;
  catalog: string;
  template?: string;
  title: string;
  display: SurfaceDisplay;
  root: string;
  components: Map<string, SurfaceComponent>;
  /** The server's order (for unknown-type reporting). */
  order: string[];
  data: JsonObject;
  /** Paths holding outside content (`external_untrusted`, §10). */
  untrustedPaths: Pointer[];
  actions: Map<string, SurfaceAction>;
  revision: number;
  state: SurfaceState;
  rawState: string;
  agentId?: string;
  /** "from <agent>" in the header (§10). */
  agentName?: string;
  /**
   * The agent's Buzz key as the server bound it (`agent.buzzPubkey`, §7.4
   * S-b): lowercase 64 hex, or absent. Buzz draws a card only when it
   * matches the message signer.
   */
  agentBuzzPubkey?: string;
  conversationId?: string;
  editorsAudience: boolean;
  repeatable: boolean;
  /** The server's rights for this viewer (§3.1). Display only. */
  viewer: { canEdit: boolean; canAct: boolean };
  lastEdit?: SurfaceLastEdit;
  status?: SurfaceStatus;
  createdAt?: string;
  updatedAt?: string;
  /** "Open on web": the dashboard's page for this surface. */
  webUrl?: string;
};

const ACTOR_KINDS = new Set<ActorKind>([
  "user",
  "agent",
  "host_app",
  "member",
  "system",
]);
const STATUS_TONES = new Set<StatusTone>([
  "info",
  "success",
  "warning",
  "danger",
]);
const ACTION_KINDS = new Set<ActionKind>([
  "run",
  "ask_agent",
  "send_message",
  "set_state",
  "open",
  "dismiss",
]);
const ACTION_STYLES = new Set<ActionStyle>([
  "primary",
  "secondary",
  "destructive",
  "plain",
]);

const stateOf = (raw: string | undefined): SurfaceState => {
  switch ((raw ?? "").toLowerCase()) {
    case "":
    case "active":
    case "open":
      return "active";
    case "submitted":
      return "submitted";
    case "dismissed":
      return "dismissed";
    case "closed":
      return "closed";
    default:
      return "other";
  }
};

export const decodeVisibility = (value: unknown): Visibility | undefined => {
  const path = asString(field(value, "path"));
  if (path === undefined || !isObject(value)) {
    return undefined;
  }
  const negated = value.not === true;
  if (Object.prototype.hasOwnProperty.call(value, "equals")) {
    return {
      path,
      test: { kind: "equals", value: value.equals ?? null },
      negated,
    };
  }
  if (Array.isArray(value.in)) {
    return { path, test: { kind: "in", values: value.in }, negated };
  }
  return {
    path,
    test: { kind: "notEmpty", wanted: asBool(value.notEmpty) ?? true },
    negated,
  };
};

const decodeComponent = (value: unknown): SurfaceComponent | undefined => {
  const id = plainId(field(value, "id"));
  const type = asString(field(value, "type"));
  if (!id || !type || type.length > 64) {
    return undefined;
  }
  const rawProps = field(value, "props");
  const props: JsonObject = isObject(rawProps) ? { ...rawProps } : {};
  const visibleWhen = decodeVisibility(
    field(value, "visibleWhen") ?? props.visibleWhen,
  );
  delete props.visibleWhen;
  return {
    id,
    type,
    known: isKnownType(type),
    props,
    ...(visibleWhen ? { visibleWhen } : {}),
  };
};

export const decodeEntityKey = (value: unknown): EntityKey | undefined => {
  const raw = asString(field(value, "type") ?? field(value, "entityType"));
  const type = raw?.replace(/-/gu, "_") as EntityType | undefined;
  const id = plainId(field(value, "id") ?? field(value, "entityId"));
  if (!type || !ENTITY_TYPES.includes(type) || !id) {
    return undefined;
  }
  const title = plainText(field(value, "title") ?? field(value, "label"), 200);
  return { type, id, ...(title ? { title } : {}) };
};

const defaultLabel = (kind: ActionKind): string => {
  switch (kind) {
    case "run":
      return "Run";
    case "ask_agent":
      return "Ask agent";
    case "send_message":
      return "Send";
    case "set_state":
      return "Change";
    case "open":
      return "Open";
    case "dismiss":
      return "Dismiss";
    default:
      return "Action";
  }
};

export const decodeAction = (
  id: string,
  value: unknown,
): SurfaceAction | undefined => {
  const rawKind = asString(field(value, "kind"));
  if (!plainId(id) || !rawKind || !isObject(value)) {
    return undefined;
  }
  const kind: ActionKind = ACTION_KINDS.has(rawKind as ActionKind)
    ? (rawKind as ActionKind)
    : "unknown";
  const style = asString(value.style) as ActionStyle | undefined;
  const action: SurfaceAction = {
    id,
    kind,
    rawKind,
    label: plainText(value.label, 200) ?? defaultLabel(kind),
    style: style && ACTION_STYLES.has(style) ? style : "secondary",
    repeatable: value.repeatable === true,
  };
  const icon = plainText(value.icon, 64);
  if (icon) {
    action.icon = icon;
  }
  if (
    hasInvisibleText(value.label) ||
    hasInvisibleText(value.text) ||
    hasInvisibleText(value.prompt)
  ) {
    action.hidden = true;
  }
  const text = plainText(value.text, 2000, true);
  if (text) {
    action.text = text;
  }
  const prompt = plainText(value.prompt, 500, true);
  if (prompt) {
    action.prompt = prompt;
  }
  const statePath = asString(value.path);
  if (statePath !== undefined && parsePointer(statePath)) {
    action.statePath = statePath;
    action.stateValue = value.value ?? null;
  }
  const target = value.target;
  if (isObject(target)) {
    const url = openableUrl(target.url);
    const entity = decodeEntityKey(target.entity);
    if (url) {
      action.target = { kind: "url", url };
    } else if (entity) {
      action.target = { kind: "entity", entity };
    } else if (target.expanded === true) {
      action.target = { kind: "expanded" };
    }
  }
  if (Array.isArray(value.validate)) {
    action.validates = value.validate.filter(
      (path): path is string =>
        typeof path === "string" && Boolean(parsePointer(path)),
    );
  }
  const call = value.call;
  const module = asString(field(call, "module"));
  const method = asString(field(call, "method"));
  if (module && method) {
    action.method = `${module}.${method}`;
  }
  return action;
};

const decodeStatus = (value: unknown): SurfaceStatus | undefined => {
  const text = plainText(field(value, "text"), 500);
  if (!text || !isObject(value)) {
    return undefined;
  }
  const tone = asString(value.tone) as StatusTone | undefined;
  const at = asString(value.at);
  const actionId = plainId(value.actionId);
  return {
    text,
    tone: tone && STATUS_TONES.has(tone) ? tone : "info",
    ...(at ? { at } : {}),
    ...(actionId ? { actionId } : {}),
    retryable: value.retryable === true,
  };
};

const httpsUrl = (raw: unknown): string | undefined => {
  const url = openableUrl(raw);
  return url?.startsWith("https://") ? url : undefined;
};

/** The component ids a container names as children (the catalog's own refs). */
const childIdsOf = (component: SurfaceComponent): string[] => {
  const props = component.props;
  const list = (value: unknown): string[] => {
    if (Array.isArray(value)) {
      return value.filter((id): id is string => typeof id === "string");
    }
    if (isObject(value) && typeof value.template === "string") {
      return [value.template];
    }
    return [];
  };
  const one = (value: unknown): string[] =>
    typeof value === "string" ? [value] : [];
  const each = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.flatMap((item) => (isObject(item) ? one(item.child) : []))
      : [];
  switch (component.type) {
    case "Stack":
    case "Grid":
    case "Section":
    case "Carousel":
      return list(props.children);
    case "Card":
      return one(props.child);
    case "Tabs":
    case "Accordion":
      return each(props.items);
    case "Steps":
      return each(props.steps);
    case "Modal":
      return [...one(props.entry), ...one(props.content)];
    default:
      return [];
  }
};

/**
 * Whether the tree is one the server would have stored (ui-catalog validate):
 * unique component ids, the root never a child, and every child named by
 * exactly one reference (79 W6 SHOULD 6). A Buzz community's agent host may
 * not be Kiingo's, so the client checks too and refuses the surface.
 */
const wellFormedTree = (
  components: readonly SurfaceComponent[],
  root: string,
): boolean => {
  const ids = new Set<string>();
  for (const component of components) {
    if (ids.has(component.id)) {
      return false;
    }
    ids.add(component.id);
  }
  const named = new Set<string>();
  for (const component of components) {
    for (const childId of childIdsOf(component)) {
      if (childId === root || named.has(childId)) {
        return false;
      }
      named.add(childId);
    }
  }
  return true;
};

/**
 * `{surface: {...}}`, `{data: {surface}}` or the surface itself (the inline
 * chat card's `payload`, `GET /api/ui/surfaces/:id`). Undefined when it isn't
 * a surface (no id or no root) or its tree is malformed (a duplicate id, a
 * child with two parents, the root as a child).
 */
export const decodeSurface = (value: unknown): Surface | undefined => {
  if (!isObject(value)) {
    return undefined;
  }
  if (isObject(value.surface)) {
    return decodeSurface(value.surface);
  }
  if (isObject(field(value.data, "surface"))) {
    return decodeSurface(field(value.data, "surface"));
  }
  const spec = isObject(value.spec) ? value.spec : undefined;
  const get = (key: string): JsonValue | undefined => value[key] ?? spec?.[key];
  const id = plainId(value.surfaceId ?? value.id);
  if (!id) {
    return undefined;
  }
  const list = get("components");
  const components = (Array.isArray(list) ? list : [])
    .slice(0, MAX_COMPONENTS)
    .map(decodeComponent)
    .filter((item): item is SurfaceComponent => Boolean(item));
  const root = plainId(get("root")) ?? components[0]?.id;
  if (!root || !wellFormedTree(components, root)) {
    return undefined;
  }
  const byId = new Map<string, SurfaceComponent>();
  for (const component of components) {
    byId.set(component.id, component);
  }
  const actions = new Map<string, SurfaceAction>();
  const rawActions = get("actions");
  if (isObject(rawActions)) {
    for (const [key, raw] of Object.entries(rawActions).slice(0, MAX_ACTIONS)) {
      const action = decodeAction(key, raw);
      if (action) {
        actions.set(key, action);
      }
    }
  }
  const untrustedPaths: Pointer[] = [];
  const trust = get("dataTrust");
  if (isObject(trust)) {
    for (const [path, level] of Object.entries(trust)) {
      const pointer = parsePointer(path);
      if (level === "external_untrusted" && pointer) {
        untrustedPaths.push(pointer);
      }
    }
  }
  const agent = value.agent;
  const viewer = value.viewer;
  const edit = value.lastEdit;
  const display = asString(get("display"));
  const rawData = get("data");
  const rawState = asString(value.state) ?? "active";
  const repeatableFlag = asBool(get("repeatable"));
  const surface: Surface = {
    id,
    catalog: asString(get("catalog")) ?? CATALOG_V1,
    title: plainText(get("title"), 200) ?? "",
    display:
      display === "expanded" || display === "carousel" ? display : "inline",
    root,
    components: byId,
    order: components.map((component) => component.id),
    data: isObject(rawData) ? rawData : {},
    untrustedPaths,
    actions,
    revision: asInt(value.revision ?? value.currentRevision) ?? 1,
    state: stateOf(rawState),
    rawState,
    editorsAudience: asString(get("editors")) === "audience",
    repeatable:
      repeatableFlag ??
      [...actions.values()].some(
        (action) => action.kind === "run" && action.repeatable,
      ),
    // No viewer block: nothing may be edited or tapped (the server decides).
    viewer: isObject(viewer)
      ? { canEdit: viewer.canEdit === true, canAct: viewer.canAct === true }
      : { canEdit: false, canAct: false },
  };
  const template = plainText(get("template"), 80);
  if (template) {
    surface.template = template;
  }
  const agentId = plainId(
    value.agentId ?? field(agent, "id") ?? field(agent, "agentId"),
  );
  if (agentId) {
    surface.agentId = agentId;
  }
  const agentName = plainText(
    value.agentName ?? field(agent, "name") ?? field(agent, "displayName"),
    80,
  );
  if (agentName) {
    surface.agentName = agentName;
  }
  // Only the server-built agent object carries it; never a top-level field.
  const agentBuzzPubkey = asString(field(agent, "buzzPubkey"))
    ?.trim()
    .toLowerCase();
  if (agentBuzzPubkey && /^[0-9a-f]{64}$/u.test(agentBuzzPubkey)) {
    surface.agentBuzzPubkey = agentBuzzPubkey;
  }
  const conversationId = plainId(value.conversationId);
  if (conversationId) {
    surface.conversationId = conversationId;
  }
  if (isObject(edit)) {
    const actorKind = asString(edit.actorKind) as ActorKind | undefined;
    surface.lastEdit = {
      ...(actorKind && ACTOR_KINDS.has(actorKind) ? { actorKind } : {}),
      ...(plainId(edit.actorId) ? { actorId: plainId(edit.actorId)! } : {}),
      ...(asString(edit.client) ? { client: asString(edit.client)! } : {}),
      ...(asString(edit.at) ? { at: asString(edit.at)! } : {}),
    };
  }
  const status = decodeStatus(value.status);
  if (status) {
    surface.status = status;
  }
  const createdAt = asString(value.createdAt);
  if (createdAt) {
    surface.createdAt = createdAt;
  }
  const updatedAt = asString(value.updatedAt);
  if (updatedAt) {
    surface.updatedAt = updatedAt;
  }
  const webUrl = httpsUrl(value.webUrl);
  if (webUrl) {
    surface.webUrl = webUrl;
  }
  return surface;
};

// --- Rules on a decoded surface ---------------------------------------------

export const isKnownCatalog = (surface: Surface): boolean =>
  surface.catalog === CATALOG_V1;

export const isOver = (surface: Surface): boolean =>
  surface.state === "dismissed" || surface.state === "closed";

const isOpen = (surface: Surface): boolean =>
  surface.state === "active" ||
  (surface.state === "submitted" && surface.repeatable);

/** Edits are taken: open, and the server says this viewer may edit. */
export const acceptsEdits = (surface: Surface): boolean =>
  surface.viewer.canEdit && isOpen(surface);

/** Taps are taken: open, and the server says this viewer may act. */
export const acceptsTaps = (surface: Surface): boolean =>
  surface.viewer.canAct && isOpen(surface);

/** `run` may be tapped: never on an audience-edited surface (R6). */
export const allowsRun = (surface: Surface): boolean =>
  acceptsTaps(surface) && !surface.editorsAudience;

/** Component types this version can't draw. */
export const unknownTypes = (surface: Surface): string[] => {
  const seen: string[] = [];
  for (const id of surface.order) {
    const component = surface.components.get(id);
    if (component && !component.known && !seen.includes(component.type)) {
      seen.push(component.type);
    }
  }
  return seen;
};

/**
 * Whether data read at `pointer` holds outside content (79 W6), the one rule
 * every renderer uses: a mark at the pointer, above it (a parent is outside)
 * or BELOW it (it reads an object or list that holds outside content).
 */
export const isUntrustedPath = (surface: Surface, pointer: Pointer): boolean =>
  surface.untrustedPaths.some((marked) => pointersOverlap(marked, pointer));

const CLIENT_LABELS: Record<string, string> = {
  companion_mac: "Mac",
  tasks_ios: "iPhone",
  dashboard: "the dashboard",
  buzz: "Buzz",
  teams: "Teams",
  mcp_app: "another app",
};

export const clientLabel = (client: string | undefined): string | undefined =>
  ownEntry(CLIENT_LABELS, client);

/**
 * "Edited on Mac" when the last change came from another of the user's
 * clients; "Changed by <agent>" when the agent changed it; "Changed in
 * another app" for an MCP Apps host edit.
 */
export const editedNote = (
  surface: Surface,
  ownClient: string,
): string | undefined => {
  const edit = surface.lastEdit;
  if (!edit) {
    return undefined;
  }
  switch (edit.actorKind) {
    case "user": {
      const label = clientLabel(edit.client);
      return edit.client !== ownClient && label
        ? `Edited on ${label}`
        : undefined;
    }
    case "agent":
      return `Changed by ${surface.agentName ?? "the agent"}`;
    case "host_app":
      return "Changed in another app";
    case "member":
      return "Changed by someone else here";
    default:
      return undefined;
  }
};
