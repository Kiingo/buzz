// Generated from the Kiingo surface renderer packages at ddface566195a525e6e24fe69b2a49f5d239ede2; do not edit here.
import {
  asNumber,
  isEmptyValue,
  isObject,
  jsonEqual,
  type JsonValue,
} from "./json";
import {
  MAX_DEPTH,
  MAX_REPEATS,
  isInputType,
  type Surface,
  type SurfaceComponent,
  type Visibility,
} from "./model";
import {
  appendPointer,
  formatPointer,
  pointersOverlap,
  readAt,
  resolvePointer,
  ROOT,
  type Pointer,
} from "./pointer";
import { formatPlainNumber, openableUrl, plainText } from "./text";

// Bindings, visibleWhen and validation (§3), shared by every renderer. Pure:
// the views ask, the controller decides.

/** `{path}` (alone, or with `template`/`default`) is a binding. */
export const bindingOf = (
  prop: unknown,
  scope: Pointer,
): Pointer | undefined => {
  if (!isObject(prop) || typeof prop.path !== "string") {
    return undefined;
  }
  if (
    !Object.keys(prop).every(
      (key) => key === "path" || key === "template" || key === "default",
    )
  ) {
    return undefined;
  }
  return resolvePointer(prop.path, scope);
};

export const isBinding = (prop: unknown): boolean =>
  isObject(prop) &&
  typeof prop.path === "string" &&
  Object.keys(prop).every((key) => key === "path" || key === "default");

/** A prop's value: the bound data (or the binding's default), else the literal. */
export const resolveProp = (
  prop: unknown,
  data: unknown,
  scope: Pointer,
): JsonValue | undefined => {
  if (prop === undefined) {
    return undefined;
  }
  if (isObject(prop) && typeof prop.path === "string" && isBinding(prop)) {
    const pointer = bindingOf(prop, scope);
    const value = pointer ? readAt(data, pointer) : undefined;
    return value ?? (prop.default as JsonValue | undefined);
  }
  return prop as JsonValue;
};

/** A prop as plain text: numbers formatted, booleans Yes/No. */
export const propText = (
  prop: unknown,
  data: unknown,
  scope: Pointer,
  max = 4000,
): string | undefined => {
  const value = resolveProp(prop, data, scope);
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  return plainText(value, max, true);
};

export const propNumber = (
  prop: unknown,
  data: unknown,
  scope: Pointer,
): number | undefined => asNumber(resolveProp(prop, data, scope));

export const propBool = (
  prop: unknown,
  data: unknown,
  scope: Pointer,
): boolean => resolveProp(prop, data, scope) === true;

/** As the catalog evaluates it: strict equality; empty is null, "", [], {}. */
export const isVisible = (
  visibility: Visibility | undefined,
  data: unknown,
  scope: Pointer,
): boolean => {
  if (!visibility) {
    return true;
  }
  const pointer = resolvePointer(visibility.path, scope);
  const value = pointer ? readAt(data, pointer) : undefined;
  let holds: boolean;
  switch (visibility.test.kind) {
    case "equals":
      holds = value !== undefined && jsonEqual(value, visibility.test.value);
      break;
    case "in": {
      const values = visibility.test.values;
      holds =
        value !== undefined &&
        values.some((candidate) => jsonEqual(candidate, value));
      break;
    }
    default: {
      const empty =
        value === undefined ||
        value === null ||
        value === "" ||
        (Array.isArray(value) && value.length === 0) ||
        (isObject(value) && Object.keys(value).length === 0);
      holds = empty !== visibility.test.wanted;
    }
  }
  return holds !== visibility.negated;
};

/** One component at one scope (repeats give each item its own scope). */
export type ChildRef = { componentId: string; scope: Pointer; key: string };

export const childKey = (componentId: string, scope: Pointer): string =>
  `${componentId}@${formatPointer(scope)}`;

/** Children of a container prop: ids, one id, or `{template, path}` repeated over an array. */
export const childrenOf = (
  prop: unknown,
  data: unknown,
  scope: Pointer,
): ChildRef[] => {
  const make = (componentId: string, at: Pointer): ChildRef => ({
    componentId,
    scope: at,
    key: childKey(componentId, at),
  });
  if (Array.isArray(prop)) {
    return prop
      .filter((id): id is string => typeof id === "string")
      .map((id) => make(id, scope));
  }
  if (typeof prop === "string") {
    return [make(prop, scope)];
  }
  if (
    isObject(prop) &&
    typeof prop.template === "string" &&
    typeof prop.path === "string"
  ) {
    const pointer = resolvePointer(prop.path, scope);
    const items = pointer ? readAt(data, pointer) : undefined;
    if (!pointer || !Array.isArray(items)) {
      return [];
    }
    return items
      .slice(0, MAX_REPEATS)
      .map((_, index) =>
        make(prop.template as string, appendPointer(pointer, index)),
      );
  }
  return [];
};

/** Props that name child components. */
export const CHILD_KEYS = ["children", "child", "entry", "content"] as const;

export type WalkEntry = {
  component: SurfaceComponent;
  scope: Pointer;
  visible: boolean;
};

/**
 * Every component reachable from the root with its scope, in order, each
 * visited once per scope (cycles and depth past 12 stop).
 */
export const walkSurface = (surface: Surface, data: unknown): WalkEntry[] => {
  const out: WalkEntry[] = [];
  const seen = new Set<string>();
  const visit = (
    child: ChildRef,
    depth: number,
    parentVisible: boolean,
  ): void => {
    if (
      depth > MAX_DEPTH ||
      out.length > surface.components.size * 4 + MAX_REPEATS
    ) {
      return;
    }
    if (seen.has(child.key)) {
      return;
    }
    const component = surface.components.get(child.componentId);
    if (!component) {
      return;
    }
    seen.add(child.key);
    const visible =
      parentVisible && isVisible(component.visibleWhen, data, child.scope);
    out.push({ component, scope: child.scope, visible });
    for (const key of CHILD_KEYS) {
      for (const next of childrenOf(component.props[key], data, child.scope)) {
        visit(next, depth + 1, visible);
      }
    }
    for (const key of ["items", "steps"]) {
      const list = component.props[key];
      if (Array.isArray(list)) {
        for (const item of list) {
          for (const next of childrenOf(
            isObject(item) ? item.child : undefined,
            data,
            child.scope,
          )) {
            visit(next, depth + 1, visible);
          }
        }
      }
    }
  };
  visit(
    {
      componentId: surface.root,
      scope: ROOT,
      key: childKey(surface.root, ROOT),
    },
    0,
    true,
  );
  return out;
};

// --- Validation (§3) ---------------------------------------------------------

export type ValidationRules = {
  label: string;
  required: boolean;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  pattern?: string;
  format?: "email" | "url" | "phone";
};

export const validationRules = (
  component: SurfaceComponent,
): ValidationRules => {
  const props = component.props;
  const format = (["email", "url", "phone"] as const).find(
    (name) => props.format === name || props.kind === name,
  );
  const rules: ValidationRules = {
    label: plainText(props.label, 80) ?? "This field",
    required: props.required === true,
  };
  const number = (key: string) =>
    typeof props[key] === "number" ? (props[key] as number) : undefined;
  if (number("minLength") !== undefined) {
    rules.minLength = number("minLength")!;
  }
  if (number("maxLength") !== undefined) {
    rules.maxLength = number("maxLength")!;
  }
  if (number("min") !== undefined) {
    rules.min = number("min")!;
  }
  if (number("max") !== undefined) {
    rules.max = number("max")!;
  }
  if (typeof props.pattern === "string" && props.pattern.length <= 300) {
    rules.pattern = props.pattern;
  }
  if (format) {
    rules.format = format;
  }
  return rules;
};

export const matchesFormat = (
  text: string,
  format: "email" | "url" | "phone",
): boolean => {
  const trimmed = text.trim();
  switch (format) {
    case "email": {
      // In code, not a backtracking pattern (79 W7).
      if (trimmed.length > 320 || /\s/u.test(trimmed)) {
        return false;
      }
      const at = trimmed.indexOf("@");
      if (at <= 0 || trimmed.indexOf("@", at + 1) >= 0) {
        return false;
      }
      const domain = trimmed.slice(at + 1);
      const dot = domain.lastIndexOf(".");
      return dot > 0 && dot < domain.length - 1;
    }
    case "url":
      return openableUrl(trimmed)?.startsWith("https://") ?? false;
    default: {
      const digits = trimmed.replace(/\D/gu, "");
      return (
        digits.length >= 7 &&
        digits.length <= 15 &&
        /^[\d\s+\-().]+$/u.test(trimmed)
      );
    }
  }
};

/** The message for `value`, or undefined when it passes. */
export const validationProblem = (
  rules: ValidationRules,
  value: unknown,
): string | undefined => {
  if (isEmptyValue(value)) {
    return rules.required ? `${rules.label} is required.` : undefined;
  }
  if (Array.isArray(value)) {
    if (rules.minLength !== undefined && value.length < rules.minLength) {
      return `Choose at least ${rules.minLength}.`;
    }
    if (rules.maxLength !== undefined && value.length > rules.maxLength) {
      return `Choose at most ${rules.maxLength}.`;
    }
    return undefined;
  }
  if (typeof value === "number") {
    if (rules.min !== undefined && value < rules.min) {
      return `${rules.label} must be at least ${formatPlainNumber(rules.min)}.`;
    }
    if (rules.max !== undefined && value > rules.max) {
      return `${rules.label} must be at most ${formatPlainNumber(rules.max)}.`;
    }
    return undefined;
  }
  const text =
    typeof value === "string"
      ? value
      : isObject(value) && typeof value.text === "string"
        ? value.text
        : undefined;
  if (text === undefined) {
    return undefined;
  }
  const length = Array.from(text).length;
  if (rules.minLength !== undefined && length < rules.minLength) {
    return `${rules.label} needs at least ${rules.minLength} characters.`;
  }
  if (rules.maxLength !== undefined && length > rules.maxLength) {
    return `${rules.label} can be at most ${rules.maxLength} characters.`;
  }
  if (rules.format && !matchesFormat(text, rules.format)) {
    switch (rules.format) {
      case "email":
        return "Enter an email address.";
      case "url":
        return "Enter a web address that starts with https://.";
      default:
        return "Enter a phone number.";
    }
  }
  // `pattern` is the agent's regular expression: the server checks it, the
  // client never runs it (79 W7: a crafted pattern could hang the page).
  return undefined;
};

/**
 * Problems in visible, enabled inputs, by child key, optionally only for
 * inputs bound under `paths` (a Steps step, an action's `validate`).
 */
export const surfaceProblems = (
  surface: Surface,
  data: unknown,
  paths?: readonly Pointer[],
): Map<string, string> => {
  const problems = new Map<string, string>();
  for (const { component, scope, visible } of walkSurface(surface, data)) {
    if (!visible || !isInputType(component.type)) {
      continue;
    }
    if (propBool(component.props.disabled, data, scope)) {
      continue;
    }
    const pointer = bindingOf(component.props.value, scope);
    if (!pointer) {
      continue;
    }
    if (paths && !paths.some((path) => pointersOverlap(path, pointer))) {
      continue;
    }
    const problem = validationProblem(
      validationRules(component),
      readAt(data, pointer),
    );
    if (problem) {
      problems.set(childKey(component.id, scope), problem);
    }
  }
  return problems;
};
