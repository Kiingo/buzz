part of '../agent_surface_view.dart';

// The richer inputs, read only: their chosen values as chips and rows.

class _RichTextValue extends StatelessWidget {
  final _Field field;
  const _RichTextValue({required this.field});

  @override
  Widget build(BuildContext context) {
    final text = richTextOf(field.value).trim();
    final colors = context.colors;
    return Container(
      width: double.infinity,
      constraints: const BoxConstraints(minHeight: 80),
      padding: const EdgeInsets.symmetric(
        horizontal: Grid.twelve,
        vertical: Grid.xxs,
      ),
      decoration: BoxDecoration(
        color: colors.surfaceContainerHighest.withValues(alpha: 0.4),
        border: Border.all(color: colors.outlineVariant),
        borderRadius: BorderRadius.circular(Radii.md),
      ),
      child: text.isEmpty
          ? Text(
              field.placeholder ?? '',
              style: _body(context, color: colors.onSurfaceVariant),
            )
          : _MarkdownText(text: cleanText(text, 20000, lines: true)),
    );
  }
}

/// A wrap of chips under the field's label, or the placeholder.
class _ChipValues extends StatelessWidget {
  final String label;
  final List<Widget> chips;
  final String? placeholder;

  const _ChipValues({
    required this.label,
    required this.chips,
    this.placeholder,
  });

  @override
  Widget build(BuildContext context) {
    if (chips.isEmpty) {
      return _ValueBox(label: label, text: null, placeholder: placeholder);
    }
    return Semantics(
      label: label,
      readOnly: true,
      child: Wrap(
        spacing: Grid.half + Grid.quarter,
        runSpacing: Grid.half + Grid.quarter,
        children: chips,
      ),
    );
  }
}

/// Chips of `{email, name?, outside?}`; `outside` is the server's flag.
class _RecipientValue extends StatelessWidget {
  final _Field field;
  const _RecipientValue({required this.field});

  @override
  Widget build(BuildContext context) {
    final raw = field.value;
    final recipients = raw is List
        ? raw
        : raw is String && raw.isNotEmpty
        ? [raw]
        : const <Object?>[];
    return _ChipValues(
      label: field.label,
      placeholder: field.placeholder,
      chips: [
        for (final item in recipients.take(100))
          _Badge(
            text:
                plainText(fieldOf(item, 'name'), 80) ??
                plainText(
                  item is String ? item : fieldOf(item, 'email'),
                  320,
                ) ??
                '?',
            tone: fieldOf(item, 'outside') == true ? 'warning' : null,
          ),
      ],
    );
  }
}

class _FileValue extends StatelessWidget {
  final _Field field;
  const _FileValue({required this.field});

  @override
  Widget build(BuildContext context) {
    final raw = field.value;
    final files = raw is List ? raw.take(50).toList() : const <Object?>[];
    if (files.isEmpty) {
      return _ValueBox(
        label: field.label,
        text: null,
        placeholder: field.placeholder ?? 'No files',
      );
    }
    return Semantics(
      label: field.label,
      child: _Gapped(
        gap: Grid.half + Grid.quarter,
        children: [for (final item in files) _FileRow(item: item)],
      ),
    );
  }
}

class _EntityValue extends StatelessWidget {
  final _Field field;
  const _EntityValue({required this.field});

  @override
  Widget build(BuildContext context) {
    final raw = field.value;
    final values = raw is List
        ? raw
        : raw is Map
        ? [raw]
        : const <Object?>[];
    return _ChipValues(
      label: field.label,
      placeholder: field.placeholder,
      chips: [
        for (final value in values.take(50))
          if (decodeEntity(value) case final entity?)
            _EntityChip(entity: entity),
      ],
    );
  }
}

/// The bound list in its current order; rows read `itemTitle` and
/// `itemSubtitle` per item.
class _ReorderValue extends StatelessWidget {
  final _Field field;
  const _ReorderValue({required this.field});

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    final raw = field.value;
    final items = raw is List
        ? raw.take(surfaceMaxRepeats).toList()
        : const <Object?>[];
    final colors = context.colors;
    return Semantics(
      label: field.label,
      child: _Gapped(
        gap: Grid.half,
        children: [
          for (final (index, item) in items.indexed)
            Builder(
              builder: (context) {
                final itemScope = appendPointer(field.pointer, index);
                final title =
                    scope.textOf(
                      field.component.props['itemTitle'],
                      itemScope,
                      max: 200,
                    ) ??
                    cellText(item);
                final subtitle = scope.textOf(
                  field.component.props['itemSubtitle'],
                  itemScope,
                  max: 300,
                );
                return MergeSemantics(
                  child: Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: Grid.xxs,
                      vertical: Grid.half + Grid.quarter,
                    ),
                    decoration: BoxDecoration(
                      color: colors.surfaceContainerHighest.withValues(
                        alpha: 0.6,
                      ),
                      borderRadius: BorderRadius.circular(Radii.md),
                    ),
                    child: Row(
                      children: [
                        Text('${index + 1}.', style: _small(context)),
                        const SizedBox(width: Grid.xxs),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Text(
                                title,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: _body(context),
                              ),
                              if (subtitle != null)
                                Text(
                                  subtitle,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: _small(context),
                                ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                );
              },
            ),
        ],
      ),
    );
  }
}

/// The offered slots by day, chosen ones marked.
class _TimeSlotValue extends StatelessWidget {
  final _Field field;
  const _TimeSlotValue({required this.field});

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    final raw = field.value;
    final chosen = raw is List
        ? raw
        : raw == null
        ? const <Object?>[]
        : [raw];
    final slots = [
      for (final item
          in scope.list(field.component, 'slots', field.scope).take(200))
        if (parseSurfaceDate(fieldOf(item, 'start')) case final start?)
          (
            start: start,
            raw: fieldOf(item, 'start'),
            label:
                plainText(fieldOf(item, 'label'), 40) ??
                formatSurfaceTime(start),
          ),
    ]..sort((a, b) => a.start.compareTo(b.start));
    final days =
        <String, List<({DateTime start, Object? raw, String label})>>{};
    for (final slot in slots) {
      final key = '${slot.start.year}-${slot.start.month}-${slot.start.day}';
      days.putIfAbsent(key, () => []).add(slot);
    }
    final colors = context.colors;
    return Semantics(
      label: field.label,
      child: _Gapped(
        children: [
          for (final day in days.values)
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(formatSurfaceDay(day.first.start), style: _small(context)),
                const SizedBox(height: Grid.half),
                Wrap(
                  spacing: Grid.half + Grid.quarter,
                  runSpacing: Grid.half + Grid.quarter,
                  children: [
                    for (final slot in day)
                      Builder(
                        builder: (context) {
                          final on = chosen.any(
                            (value) =>
                                jsonEqual(fieldOf(value, 'start'), slot.raw),
                          );
                          return Semantics(
                            label:
                                '${formatSurfaceDay(slot.start)} '
                                '${formatSurfaceTime(slot.start)}',
                            selected: on,
                            excludeSemantics: true,
                            child: Container(
                              padding: const EdgeInsets.symmetric(
                                horizontal: Grid.twelve,
                                vertical: Grid.half,
                              ),
                              decoration: BoxDecoration(
                                color: on
                                    ? colors.primary.withValues(alpha: 0.12)
                                    : null,
                                border: Border.all(
                                  color: on
                                      ? colors.primary
                                      : colors.outlineVariant,
                                ),
                                borderRadius: BorderRadius.circular(Radii.full),
                              ),
                              child: Text(slot.label, style: _small(context)),
                            ),
                          );
                        },
                      ),
                  ],
                ),
              ],
            ),
        ],
      ),
    );
  }
}
