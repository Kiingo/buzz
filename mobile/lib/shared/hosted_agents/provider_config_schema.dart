import 'package:flutter/foundation.dart';

/// Generic rules for a provider-owned execution-profile JSON schema, ported
/// from the desktop's `providerConfigSchema.ts` so both clients read the same
/// schema the same way. Provider ids never appear here.

/// A schema property.
typedef ProviderConfigProperty = Map<String, Object?>;

/// One bounded choice for a property.
@immutable
class ProviderConfigOption {
  const ProviderConfigOption({
    required this.value,
    required this.label,
    this.description,
    this.extra = const {},
  });

  final String value;
  final String label;
  final String? description;

  /// Other option properties (for example `selector_kind`).
  final Map<String, Object?> extra;
}

/// Properties in schema declaration order.
List<MapEntry<String, ProviderConfigProperty>> providerConfigEntries(
  Map<String, Object?> schema,
) {
  final properties = schema['properties'];
  if (properties is! Map) return const [];
  return [
    for (final entry in properties.entries)
      if (entry.value is Map)
        MapEntry(
          entry.key.toString(),
          Map<String, Object?>.from(entry.value as Map),
        ),
  ];
}

/// A property's scalar default as a form value.
String providerConfigDefault(ProviderConfigProperty property) {
  final value = property['default'];
  if (value is String || value is num || value is bool) return '$value';
  return '';
}

/// Initial form values: every property's default.
Map<String, String> providerConfigDefaults(Map<String, Object?> schema) => {
  for (final entry in providerConfigEntries(schema))
    if (entry.value['default'] != null)
      entry.key: providerConfigDefault(entry.value),
};

/// Whether a property is shown for the current configuration.
bool providerConfigFieldVisible(
  ProviderConfigProperty property,
  Map<String, String> config,
) {
  // Provider bookkeeping (revisions, catalog versions) travels as a default
  // without a field.
  if (property['x-hidden'] == true) return false;
  if (property['x-hide-when-no-options'] == true &&
      (providerConfigOptions(property, config)?.isEmpty ?? false)) {
    return false;
  }
  final condition = property['x-visible-when'];
  if (condition is! Map) return true;
  final field = condition['field'];
  if (field is! String) return true;
  final selected = config[field] ?? '';
  final equals = condition['equals'];
  if (equals is String) return selected == equals;
  final not = condition['not'];
  if (not is String) return selected != not;
  return true;
}

ProviderConfigOption? _option(Object? value) {
  if (value is! Map) return null;
  final optionValue = value['value'];
  final label = value['label'];
  if (optionValue is! String || label is! String) return null;
  final description = value['description'];
  return ProviderConfigOption(
    value: optionValue,
    label: label,
    description: description is String ? description : null,
    extra: {
      for (final entry in value.entries)
        if (!const {'value', 'label', 'description'}.contains(entry.key))
          entry.key.toString(): entry.value,
    },
  );
}

List<ProviderConfigOption> _options(Object? values) => values is List
    ? values.map(_option).whereType<ProviderConfigOption>().toList()
    : const [];

/// A property's bounded options for the current configuration, or `null` when
/// the property is free-form.
List<ProviderConfigOption>? providerConfigOptions(
  ProviderConfigProperty property, [
  Map<String, String> config = const {},
]) {
  final multiple = property['x-options-by-fields'];
  if (multiple is Map) {
    final fields = multiple['fields'] is List
        ? (multiple['fields'] as List).whereType<String>().toList()
        : const <String>[];
    final optionMap = multiple['options'];
    if (fields.isEmpty || fields.length > 4 || optionMap is! Map) {
      return const [];
    }
    return _options(optionMap[fields.map((f) => config[f] ?? '').join('|')]);
  }

  final dependency = property['x-options-by-field'];
  if (dependency is Map) {
    final field = dependency['field'];
    final optionMap = dependency['options'];
    var options = field is String && optionMap is Map
        ? _options(optionMap[config[field] ?? ''])
        : <ProviderConfigOption>[];
    final filter = property['x-option-filter'];
    if (filter is Map) {
      final filterField = filter['field'];
      final optionProperty = filter['option_property'];
      if (filterField is String &&
          optionProperty is String &&
          (config[filterField] ?? '').isNotEmpty) {
        options = options
            .where((o) => o.extra[optionProperty] == config[filterField])
            .toList();
      }
    }
    return options;
  }

  final enumValues = property['enum'];
  if (enumValues is List) {
    final labels = property['x-enum-labels'] is Map
        ? property['x-enum-labels'] as Map
        : const {};
    return [
      for (final value in enumValues)
        if (value is String || value is num)
          ProviderConfigOption(
            value: '$value',
            label: labels['$value'] is String
                ? labels['$value'] as String
                : '$value',
          ),
    ];
  }

  final oneOf = property['oneOf'];
  if (oneOf is List) {
    final options = [
      for (final entry in oneOf)
        if (entry is Map && (entry['const'] is String || entry['const'] is num))
          ProviderConfigOption(
            value: '${entry['const']}',
            label: entry['title'] is String
                ? entry['title'] as String
                : '${entry['const']}',
          ),
    ];
    return options.isEmpty ? null : options;
  }

  if (property['type'] == 'boolean') {
    return const [
      ProviderConfigOption(value: 'true', label: 'Yes'),
      ProviderConfigOption(value: 'false', label: 'No'),
    ];
  }
  return null;
}

/// Reconcile dependent values after [key] changes to [value]: hidden values
/// return to their default, and visible bounded values that no longer exist
/// return to a still-valid default or to empty.
Map<String, String> reconcileProviderConfig(
  List<MapEntry<String, ProviderConfigProperty>> entries,
  Map<String, String> config,
  String key,
  String value,
) {
  final next = {...config, key: value};
  for (final entry in entries) {
    final dependentKey = entry.key;
    final property = entry.value;
    if (!providerConfigFieldVisible(property, next)) {
      next[dependentKey] = providerConfigDefault(property);
      continue;
    }
    final options = providerConfigOptions(property, next);
    final current = next[dependentKey] ?? '';
    if (options != null &&
        current.isNotEmpty &&
        !options.any((option) => option.value == current)) {
      final fallback = providerConfigDefault(property);
      next[dependentKey] = options.any((option) => option.value == fallback)
          ? fallback
          : '';
    }
  }
  return next;
}

/// Keys of fields that still need a choice: a field shown only because of
/// another choice (`x-visible-when`) with bounded options must hold one of its
/// current options, so an impossible combination never reaches the API.
List<String> providerConfigUnmetChoices(
  Map<String, Object?> schema,
  Map<String, String> config,
) => [
  for (final entry in providerConfigEntries(schema))
    if (entry.value['x-visible-when'] != null &&
        providerConfigFieldVisible(entry.value, config))
      if (providerConfigOptions(entry.value, config) case final options?)
        if (!options.any(
          (option) =>
              option.value ==
              (config[entry.key] ?? providerConfigDefault(entry.value)),
        ))
          entry.key,
];

/// Whether every required field has a value and no dependent choice is unmet.
bool providerConfigComplete(
  Map<String, Object?> schema,
  Map<String, String> config,
) {
  final required = schema['required'] is List
      ? (schema['required'] as List).whereType<String>()
      : const <String>[];
  return required.every((key) => (config[key] ?? '').trim().isNotEmpty) &&
      providerConfigUnmetChoices(schema, config).isEmpty;
}

/// The typed configuration create sends: integers and numbers become numbers
/// (empty ones are dropped), booleans become booleans, everything else stays a
/// string.
Map<String, Object> coerceProviderConfig(
  Map<String, String> config,
  Map<String, Object?> schema,
) {
  final properties = schema['properties'] is Map
      ? schema['properties'] as Map
      : const {};
  final result = <String, Object>{};
  for (final entry in config.entries) {
    final property = properties[entry.key];
    final type = property is Map ? property['type'] : null;
    if (type == 'integer' || type == 'number') {
      if (entry.value.isEmpty) continue;
      result[entry.key] = num.tryParse(entry.value) ?? entry.value;
    } else if (type == 'boolean') {
      result[entry.key] = entry.value == 'true';
    } else {
      result[entry.key] = entry.value;
    }
  }
  return result;
}
