import { Input } from "@/shared/ui/input";
import { PersonaDropdownField } from "./PersonaDropdownField";

type ProviderFieldOption = {
  value: string;
  label: string;
  description?: string;
  [key: string]: unknown;
};

export function providerFieldVisible(
  prop: Record<string, unknown>,
  config: Record<string, string>,
): boolean {
  if (
    prop["x-hide-when-no-options"] === true &&
    providerFieldOptions(prop, config)?.length === 0
  ) {
    return false;
  }
  const condition = prop["x-visible-when"];
  if (!condition || typeof condition !== "object" || Array.isArray(condition)) {
    return true;
  }
  const field = (condition as Record<string, unknown>).field;
  if (typeof field !== "string") return true;
  const value = config[field] ?? "";
  const equals = (condition as Record<string, unknown>).equals;
  const not = (condition as Record<string, unknown>).not;
  if (typeof equals === "string") return value === equals;
  if (typeof not === "string") return value !== not;
  return true;
}

export function providerFieldOptions(
  prop: Record<string, unknown>,
  config: Record<string, string>,
): ProviderFieldOption[] | null {
  const multiDependent = prop["x-options-by-fields"];
  if (
    multiDependent &&
    typeof multiDependent === "object" &&
    !Array.isArray(multiDependent)
  ) {
    const source = multiDependent as Record<string, unknown>;
    const fields = Array.isArray(source.fields)
      ? source.fields.filter((field): field is string => typeof field === "string")
      : [];
    const options =
      source.options &&
      typeof source.options === "object" &&
      !Array.isArray(source.options)
        ? (source.options as Record<string, unknown>)
        : null;
    if (fields.length === 0 || fields.length > 4 || !options) return [];
    const selectedOptions = options[
      fields.map((field) => config[field] ?? "").join("|")
    ];
    return Array.isArray(selectedOptions)
      ? selectedOptions.filter(
          (entry): entry is ProviderFieldOption =>
            Boolean(entry) &&
            typeof entry === "object" &&
            !Array.isArray(entry) &&
            typeof (entry as ProviderFieldOption).value === "string" &&
            typeof (entry as ProviderFieldOption).label === "string",
        )
      : [];
  }
  const dependent = prop["x-options-by-field"];
  if (dependent && typeof dependent === "object" && !Array.isArray(dependent)) {
    const source = dependent as Record<string, unknown>;
    const field = typeof source.field === "string" ? source.field : null;
    const options =
      source.options &&
      typeof source.options === "object" &&
      !Array.isArray(source.options)
        ? (source.options as Record<string, unknown>)
        : null;
    const selected = field ? (config[field] ?? "") : null;
    const selectedOptions = selected !== null ? options?.[selected] : undefined;
    if (Array.isArray(selectedOptions)) {
      let result = selectedOptions.filter(
        (entry): entry is ProviderFieldOption =>
          Boolean(entry) &&
          typeof entry === "object" &&
          !Array.isArray(entry) &&
          typeof (entry as ProviderFieldOption).value === "string" &&
          typeof (entry as ProviderFieldOption).label === "string",
      );
      const filter = prop["x-option-filter"];
      if (filter && typeof filter === "object" && !Array.isArray(filter)) {
        const filterRecord = filter as Record<string, unknown>;
        const filterField =
          typeof filterRecord.field === "string" ? filterRecord.field : null;
        const optionProperty =
          typeof filterRecord.option_property === "string"
            ? filterRecord.option_property
            : null;
        if (filterField && optionProperty && config[filterField]) {
          result = result.filter(
            (entry) => entry[optionProperty] === config[filterField],
          );
        }
      }
      return result;
    }
    return [];
  }

  if (Array.isArray(prop.enum)) {
    const labels =
      prop["x-enum-labels"] &&
      typeof prop["x-enum-labels"] === "object" &&
      !Array.isArray(prop["x-enum-labels"])
        ? (prop["x-enum-labels"] as Record<string, unknown>)
        : {};
    return prop.enum
      .filter(
        (value): value is string | number | boolean =>
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean",
      )
      .map((value) => {
        const serialized = String(value);
        return {
          value: serialized,
          label:
            typeof labels[serialized] === "string"
              ? labels[serialized]
              : serialized,
        };
      });
  }
  if (prop.type === "boolean") {
    return [
      { label: "Yes", value: "true" },
      { label: "No", value: "false" },
    ];
  }
  return null;
}

/// Coerce string config values to their schema-declared types (number, boolean).
/// Providers receive JSON — sending "3" instead of 3 for an integer field breaks
/// typed config parsing on the provider side.
export function coerceConfigValues(
  config: Record<string, string>,
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!schema) return { ...config };
  const properties = ((schema as Record<string, unknown>)?.properties ??
    {}) as Record<string, Record<string, unknown>>;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    const prop = properties[key] as Record<string, unknown> | undefined;
    const schemaType = prop?.type;
    if (schemaType === "integer" || schemaType === "number") {
      if (value === "") continue;
      const num = Number(value);
      result[key] = Number.isNaN(num) ? value : num;
    } else if (schemaType === "boolean") {
      result[key] = value === "true";
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function ProviderConfigFields({
  schema,
  config,
  onChange,
}: {
  schema: Record<string, unknown>;
  config: Record<string, string>;
  onChange: (config: Record<string, string>) => void;
}) {
  const properties = (schema as Record<string, unknown>)?.properties ?? {};
  const required = new Set<string>(
    ((schema as Record<string, unknown>)?.required as string[]) ?? [],
  );

  const entries = Object.entries(properties) as [
    string,
    Record<string, unknown>,
  ][];

  if (entries.length === 0) {
    return null;
  }

  const updateConfig = (key: string, value: string) => {
    const next = { ...config, [key]: value };
    for (const [dependentKey, dependentProperty] of entries) {
      if (!providerFieldVisible(dependentProperty, next)) {
        next[dependentKey] =
          dependentProperty.default == null
            ? ""
            : String(dependentProperty.default);
        continue;
      }
      const options = providerFieldOptions(dependentProperty, next);
      if (
        options &&
        next[dependentKey] &&
        !options.some((option) => option.value === next[dependentKey])
      ) {
        const defaultValue =
          dependentProperty.default == null
            ? ""
            : String(dependentProperty.default);
        next[dependentKey] = options.some(
          (option) => option.value === defaultValue,
        )
          ? defaultValue
          : "";
      }
    }
    onChange(next);
  };

  return (
    <div className="space-y-3">
      {entries.map(([key, prop]) => {
        if (!providerFieldVisible(prop, config)) return null;
        const options = providerFieldOptions(prop, config);
        const value =
          config[key] ??
          (prop.default === undefined || prop.default === null
            ? ""
            : String(prop.default));
        return (
          <div key={key} className="space-y-1.5">
            <label
              className="text-sm font-medium"
              htmlFor={`provider-cfg-${key}`}
            >
              {typeof prop.title === "string" ? prop.title : key}
              {required.has(key) ? (
                <span className="ml-1 text-destructive">*</span>
              ) : null}
            </label>
            {prop.readOnly === true ? (
              <p
                className="rounded-xl border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
                id={`provider-cfg-${key}`}
              >
                {value}
              </p>
            ) : options ? (
              <PersonaDropdownField
                id={`provider-cfg-${key}`}
                onValueChange={(nextValue) => updateConfig(key, nextValue)}
                options={options}
                placeholder={`Choose ${
                  typeof prop.title === "string"
                    ? prop.title.toLowerCase()
                    : key
                }`}
                value={value}
              />
            ) : (
              <Input
                id={`provider-cfg-${key}`}
                onChange={(e) => updateConfig(key, e.target.value)}
                placeholder={
                  typeof prop.description === "string" ? prop.description : ""
                }
                type={
                  prop.type === "integer" || prop.type === "number"
                    ? "number"
                    : "text"
                }
                value={value}
              />
            )}
            {typeof prop.description === "string" ? (
              <p className="text-xs text-muted-foreground">
                {prop.description}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
