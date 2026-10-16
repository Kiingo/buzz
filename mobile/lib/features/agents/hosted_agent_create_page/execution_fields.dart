part of '../hosted_agent_create_page.dart';

/// The provider's execution-profile fields (harness, model, ...) rendered
/// from its schema in declaration order. Bounded fields are chip groups, so
/// a harness's model families (for example Sol, Astra, Luna and Terra for
/// Codex) read as one tap each.
class _ExecutionFields extends StatelessWidget {
  const _ExecutionFields({
    required this.schema,
    required this.config,
    required this.enabled,
    required this.onChanged,
  });

  final Map<String, Object?> schema;
  final Map<String, String> config;
  final bool enabled;
  final void Function(String key, String value) onChanged;

  @override
  Widget build(BuildContext context) {
    final entries = providerConfigEntries(schema);
    final unmet = providerConfigUnmetChoices(schema, config).toSet();
    final fields = <Widget>[
      for (final entry in entries)
        if (providerConfigFieldVisible(entry.value, config))
          _ExecutionField(
            key: ValueKey('hosted-agent-field-${entry.key}'),
            property: entry.value,
            value: config[entry.key] ?? providerConfigDefault(entry.value),
            options: providerConfigOptions(entry.value, config),
            needsChoice: unmet.contains(entry.key),
            enabled: enabled,
            onChanged: (value) => onChanged(entry.key, value),
          ),
    ];
    return AppListCard(
      label: 'Harness and model',
      verticalPadding: Grid.twelve,
      children: fields,
    );
  }
}

class _ExecutionField extends StatelessWidget {
  const _ExecutionField({
    super.key,
    required this.property,
    required this.value,
    required this.options,
    required this.needsChoice,
    required this.enabled,
    required this.onChanged,
  });

  final ProviderConfigProperty property;
  final String value;
  final List<ProviderConfigOption>? options;
  final bool needsChoice;
  final bool enabled;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    final title = property['title'] is String
        ? property['title'] as String
        : 'Option';
    final options = this.options;
    ProviderConfigOption? selected;
    for (final option in options ?? const <ProviderConfigOption>[]) {
      if (option.value == value) selected = option;
    }
    final description = selected?.description;
    return Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: Grid.xs,
        vertical: Grid.xxs,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: context.textTheme.labelLarge),
          const SizedBox(height: Grid.xxs),
          if (options == null)
            _FreeTextField(value: value, enabled: enabled, onChanged: onChanged)
          else if (options.isEmpty)
            Text(
              'Nothing is available for this combination yet. Choose a '
              'different option above.',
              style: context.textTheme.bodySmall?.copyWith(
                color: context.colors.error,
              ),
            )
          else
            Wrap(
              spacing: Grid.xxs,
              runSpacing: Grid.xxs,
              children: [
                for (final option in options)
                  ChoiceChip(
                    key: ValueKey('hosted-agent-option-${option.value}'),
                    label: Text(option.label),
                    selected: option.value == value,
                    onSelected: enabled
                        ? (_) {
                            unawaited(HapticFeedback.selectionClick());
                            onChanged(option.value);
                          }
                        : null,
                  ),
              ],
            ),
          if (needsChoice && (options?.isNotEmpty ?? false)) ...[
            const SizedBox(height: Grid.half),
            Text(
              'Choose one to continue.',
              style: context.textTheme.bodySmall?.copyWith(
                color: context.colors.error,
              ),
            ),
          ] else if (description != null && description.isNotEmpty) ...[
            const SizedBox(height: Grid.half),
            Text(
              description,
              style: context.textTheme.bodySmall?.copyWith(
                color: context.colors.onSurfaceVariant,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _FreeTextField extends HookWidget {
  const _FreeTextField({
    required this.value,
    required this.enabled,
    required this.onChanged,
  });

  final String value;
  final bool enabled;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    final controller = useTextEditingController(text: value);
    return TextField(
      controller: controller,
      enabled: enabled,
      onChanged: onChanged,
      decoration: const InputDecoration(isDense: true),
    );
  }
}
