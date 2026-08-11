import { Input } from "@/shared/ui/input";
import { PersonaDropdownField } from "./PersonaDropdownField";

type ProviderConfigOption = {
  label: string;
  value: string;
  [key: string]: unknown;
};

export function providerConfigFieldVisible(
  property: Record<string, unknown>,
  config: Record<string, string>,
): boolean {
  if (
    property["x-hide-when-no-options"] === true &&
    providerConfigOptions(property, config)?.length === 0
  ) {
    return false;
  }
  const condition = property["x-visible-when"];
  if (!condition || typeof condition !== "object" || Array.isArray(condition)) {
    return true;
  }
  const record = condition as Record<string, unknown>;
  if (typeof record.field !== "string") return true;
  const selected = config[record.field] ?? "";
  if (typeof record.equals === "string") return selected === record.equals;
  if (typeof record.not === "string") return selected !== record.not;
  return true;
}

export function providerConfigOptions(
  property: Record<string, unknown>,
  config: Record<string, string> = {},
): ProviderConfigOption[] | null {
  const multipleDependencies = property["x-options-by-fields"];
  if (
    multipleDependencies &&
    typeof multipleDependencies === "object" &&
    !Array.isArray(multipleDependencies)
  ) {
    const source = multipleDependencies as Record<string, unknown>;
    const fields = Array.isArray(source.fields)
      ? source.fields.filter(
          (field): field is string => typeof field === "string",
        )
      : [];
    const optionMap =
      source.options &&
      typeof source.options === "object" &&
      !Array.isArray(source.options)
        ? (source.options as Record<string, unknown>)
        : null;
    if (fields.length === 0 || fields.length > 4 || !optionMap) return [];
    const selected =
      optionMap[fields.map((field) => config[field] ?? "").join("|")];
    return Array.isArray(selected)
      ? selected.filter(isProviderConfigOption)
      : [];
  }

  const dependency = property["x-options-by-field"];
  if (
    dependency &&
    typeof dependency === "object" &&
    !Array.isArray(dependency)
  ) {
    const source = dependency as Record<string, unknown>;
    const field = typeof source.field === "string" ? source.field : null;
    const optionMap =
      source.options &&
      typeof source.options === "object" &&
      !Array.isArray(source.options)
        ? (source.options as Record<string, unknown>)
        : null;
    const selected = field ? optionMap?.[config[field] ?? ""] : null;
    let options = Array.isArray(selected)
      ? selected.filter(isProviderConfigOption)
      : [];
    const filter = property["x-option-filter"];
    if (filter && typeof filter === "object" && !Array.isArray(filter)) {
      const record = filter as Record<string, unknown>;
      if (
        typeof record.field === "string" &&
        typeof record.option_property === "string" &&
        config[record.field]
      ) {
        options = options.filter(
          (option) =>
            option[record.option_property as string] ===
            config[record.field as string],
        );
      }
    }
    return options;
  }

  if (Array.isArray(property.enum)) {
    const labels =
      property["x-enum-labels"] &&
      typeof property["x-enum-labels"] === "object" &&
      !Array.isArray(property["x-enum-labels"])
        ? (property["x-enum-labels"] as Record<string, unknown>)
        : {};
    return property.enum
      .filter((value): value is string | number =>
        ["string", "number"].includes(typeof value),
      )
      .map((value) => {
        const serialized = String(value);
        return {
          label:
            typeof labels[serialized] === "string"
              ? (labels[serialized] as string)
              : serialized,
          value: serialized,
        };
      });
  }

  if (Array.isArray(property.oneOf)) {
    const options = property.oneOf.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const option = entry as Record<string, unknown>;
      if (
        typeof option.const !== "string" &&
        typeof option.const !== "number"
      ) {
        return [];
      }
      return [
        {
          label:
            typeof option.title === "string"
              ? option.title
              : String(option.const),
          value: String(option.const),
        },
      ];
    });
    return options.length > 0 ? options : null;
  }

  if (property.type === "boolean") {
    return [
      { label: "Yes", value: "true" },
      { label: "No", value: "false" },
    ];
  }

  return null;
}

function isProviderConfigOption(value: unknown): value is ProviderConfigOption {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as ProviderConfigOption).value === "string" &&
    typeof (value as ProviderConfigOption).label === "string"
  );
}

/// Coerce string config values to their schema-declared types (number, boolean).
/// Providers receive JSON; sending "3" instead of 3 for an integer field breaks
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
      if (!providerConfigFieldVisible(dependentProperty, next)) {
        next[dependentKey] =
          dependentProperty.default == null
            ? ""
            : String(dependentProperty.default);
        continue;
      }
      const options = providerConfigOptions(dependentProperty, next);
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
        if (!providerConfigFieldVisible(prop, config)) return null;
        const options = providerConfigOptions(prop, config);
        const defaultValue =
          typeof prop.default === "string" ||
          typeof prop.default === "number" ||
          typeof prop.default === "boolean"
            ? String(prop.default)
            : "";
        const value = config[key] ?? defaultValue;

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
                max={
                  typeof prop.maximum === "number" ? prop.maximum : undefined
                }
                min={
                  typeof prop.minimum === "number" ? prop.minimum : undefined
                }
                onChange={(event) => updateConfig(key, event.target.value)}
                placeholder={
                  typeof prop.description === "string" ? prop.description : ""
                }
                step={prop.type === "integer" ? 1 : undefined}
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
