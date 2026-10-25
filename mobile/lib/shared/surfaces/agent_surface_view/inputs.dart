part of '../agent_surface_view.dart';

// §4.3 Inputs, drawn read only: this app shows surfaces view only, so each
// input shows its label and current value, and changes happen in Kiingo. A
// field that asks for a secret is never drawn (§10, R11).

const _labelBeside = {'Checkbox', 'Toggle'};

class _InputView extends StatelessWidget {
  final _NodeProps p;
  const _InputView(this.p);

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    final label = scope.text(p.component, 'label', p.scope, max: 80) ?? 'Field';
    final help = scope.text(p.component, 'help', p.scope, max: 300);
    final placeholder = scope.text(
      p.component,
      'placeholder',
      p.scope,
      max: 120,
    );
    if (asksForSecret([label, help, placeholder])) {
      return Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            BuzzIcons.lock,
            size: 14,
            color: context.colors.onSurfaceVariant,
          ),
          const SizedBox(width: Grid.half + Grid.quarter),
          Expanded(
            child: Text(
              'This field asked for a password or code, so it isn’t shown. '
              'Kiingo never collects those here.',
              style: _small(context),
            ),
          ),
        ],
      );
    }
    final pointer = bindingOf(p.component.props['value'], p.scope);
    if (pointer == null) return const SizedBox.shrink();
    final field = (
      component: p.component,
      scope: p.scope,
      pointer: pointer,
      label: label,
      placeholder: placeholder,
      value: readAt(scope.data, pointer),
    );
    final required = p.component.props['required'] == true;
    return _Gapped(
      gap: Grid.half,
      children: [
        if (!_labelBeside.contains(p.component.type))
          ExcludeSemantics(
            child: Text(
              required ? '$label *' : label,
              style: _body(context, weight: FontWeight.w500),
            ),
          ),
        _field(context, scope, field),
        if (help != null) Text(help, style: _small(context)),
      ],
    );
  }
}

typedef _Field = ({
  SurfaceComponent component,
  Pointer scope,
  Pointer pointer,
  String label,
  String? placeholder,
  Object? value,
});

Widget _field(BuildContext context, _SurfaceContext scope, _Field f) =>
    switch (f.component.type) {
      'TextField' => _textValue(context, scope, f),
      'RichTextEditor' => _RichTextValue(field: f),
      'RecipientField' => _RecipientValue(field: f),
      'Select' => _selectValue(context, scope, f),
      'ChoicePicker' => _ChoiceValue(field: f),
      'Checkbox' || 'Toggle' => _BoolValue(field: f),
      'Slider' => _SliderValue(field: f),
      'Stepper' => _stepperValue(context, scope, f),
      'DateTimeInput' => _dateValue(context, scope, f),
      'Rating' => _RatingValue(field: f),
      'FileInput' => _FileValue(field: f),
      'EntityPicker' => _EntityValue(field: f),
      'Reorder' => _ReorderValue(field: f),
      'TimeSlotPicker' => _TimeSlotValue(field: f),
      _ => const SizedBox.shrink(),
    };

/// A read-only field box: the value, or the placeholder in muted text.
class _ValueBox extends StatelessWidget {
  final String label;
  final String? text;
  final String? placeholder;
  final bool multiline;

  const _ValueBox({
    required this.label,
    required this.text,
    this.placeholder,
    this.multiline = false,
  });

  @override
  Widget build(BuildContext context) {
    final value = text;
    final colors = context.colors;
    return Semantics(
      label: label,
      value: value ?? '',
      readOnly: true,
      excludeSemantics: true,
      child: Container(
        width: double.infinity,
        constraints: BoxConstraints(minHeight: multiline ? 80 : 0),
        padding: const EdgeInsets.symmetric(
          horizontal: Grid.twelve,
          vertical: Grid.xxs,
        ),
        decoration: BoxDecoration(
          color: colors.surfaceContainerHighest.withValues(alpha: 0.4),
          border: Border.all(color: colors.outlineVariant),
          borderRadius: BorderRadius.circular(Radii.md),
        ),
        child: Text(
          value ?? placeholder ?? '',
          style: _body(
            context,
            color: value == null ? colors.onSurfaceVariant : colors.onSurface,
          ),
        ),
      ),
    );
  }
}

Widget _textValue(BuildContext context, _SurfaceContext scope, _Field f) {
  final value = f.value;
  final text = value is num ? formatPlainNumber(value) : cellText(value);
  return _ValueBox(
    label: f.label,
    text: text.isEmpty ? null : text,
    placeholder: f.placeholder,
    multiline: scope.string(f.component, 'kind') == 'long',
  );
}

typedef _Option = ({int index, Object? value, String label, String? detail});

List<_Option> _optionsOf(_SurfaceContext scope, _Field f) => [
  for (final (index, item)
      in scope.list(f.component, 'options', f.scope).take(200).indexed)
    if (asObject(item) case final object?)
      (
        index: index,
        value: object['value'],
        label: plainText(object['label'] ?? object['value'], 200) ?? '',
        detail: plainText(object['description'], 500, lines: true),
      )
    else if (plainText(item, 120) case final label?)
      (index: index, value: item, label: label, detail: null),
];

Widget _selectValue(BuildContext context, _SurfaceContext scope, _Field f) {
  final value = f.value;
  final chosen = value == null
      ? null
      : _optionsOf(
          scope,
          f,
        ).where((option) => jsonEqual(option.value, value)).firstOrNull;
  return _ValueBox(
    label: f.label,
    text: chosen?.label,
    placeholder: f.placeholder ?? 'Choose…',
  );
}

class _ChoiceValue extends StatelessWidget {
  final _Field field;
  const _ChoiceValue({required this.field});

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    final options = _optionsOf(scope, field);
    final multi = scope.string(field.component, 'mode') == 'multiple';
    final style =
        scope.string(field.component, 'style') ??
        (multi ? 'checkbox' : 'radio');
    final raw = field.value;
    final selected = raw is List
        ? raw
        : raw == null
        ? const <Object?>[]
        : [raw];
    bool isOn(_Option option) =>
        selected.any((value) => jsonEqual(value, option.value));
    final colors = context.colors;
    if (style == 'chips') {
      return Semantics(
        label: field.label,
        child: Wrap(
          spacing: Grid.half + Grid.quarter,
          runSpacing: Grid.half + Grid.quarter,
          children: [
            for (final option in options)
              FilterChip(
                label: Text(option.label),
                selected: isOn(option),
                showCheckmark: multi,
                onSelected: null,
              ),
          ],
        ),
      );
    }
    return Semantics(
      label: field.label,
      child: _Gapped(
        gap: style == 'cards' ? Grid.xxs : Grid.half + Grid.quarter,
        children: [
          for (final option in options)
            Semantics(
              checked: isOn(option),
              inMutuallyExclusiveGroup: !multi,
              enabled: false,
              label: option.label,
              excludeSemantics: true,
              child: Container(
                padding: style == 'cards'
                    ? const EdgeInsets.all(Grid.xxs + Grid.quarter)
                    : EdgeInsets.zero,
                decoration: style == 'cards'
                    ? BoxDecoration(
                        color: isOn(option)
                            ? colors.primary.withValues(alpha: 0.05)
                            : null,
                        border: Border.all(
                          color: isOn(option)
                              ? colors.primary
                              : colors.outlineVariant,
                        ),
                        borderRadius: BorderRadius.circular(Radii.lg),
                      )
                    : null,
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Icon(
                      multi
                          ? (isOn(option)
                                ? BuzzIcons.circleCheck
                                : BuzzIcons.square)
                          : (isOn(option)
                                ? BuzzIcons.circleDot
                                : BuzzIcons.circle),
                      size: 16,
                      color: isOn(option)
                          ? colors.primary
                          : colors.onSurfaceVariant,
                    ),
                    const SizedBox(width: Grid.xxs),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(option.label, style: _body(context)),
                          if (option.detail case final detail?)
                            Text(detail, style: _small(context)),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _BoolValue extends StatelessWidget {
  final _Field field;
  const _BoolValue({required this.field});

  @override
  Widget build(BuildContext context) {
    final on = field.value == true;
    final toggle = field.component.type == 'Toggle';
    return MergeSemantics(
      child: Row(
        children: [
          if (toggle)
            Switch(value: on, onChanged: null)
          else
            Checkbox(value: on, onChanged: null),
          const SizedBox(width: Grid.half),
          Expanded(child: Text(field.label, style: _body(context))),
        ],
      ),
    );
  }
}

class _SliderValue extends StatelessWidget {
  final _Field field;
  const _SliderValue({required this.field});

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    final low = (scope.number(field.component, 'min', field.scope) ?? 0)
        .toDouble();
    final high = math.max(
      low + 1,
      (scope.number(field.component, 'max', field.scope) ?? 100).toDouble(),
    );
    final unit = scope.text(field.component, 'unit', field.scope, max: 12);
    final value = (asNumber(field.value) ?? low).toDouble().clamp(low, high);
    final text = '${formatPlainNumber(value)}${unit == null ? '' : ' $unit'}';
    return Semantics(
      label: field.label,
      value: text,
      readOnly: true,
      excludeSemantics: true,
      child: Row(
        children: [
          Expanded(
            child: Slider(value: value, min: low, max: high, onChanged: null),
          ),
          Text(text, style: _small(context, color: context.colors.onSurface)),
        ],
      ),
    );
  }
}

Widget _stepperValue(BuildContext context, _SurfaceContext scope, _Field f) {
  final unit = scope.text(f.component, 'unit', f.scope, max: 12);
  final number = asNumber(f.value);
  return _ValueBox(
    label: f.label,
    text: number == null
        ? null
        : '${formatPlainNumber(number)}${unit == null ? '' : ' $unit'}',
    placeholder: f.placeholder,
  );
}

Widget _dateValue(BuildContext context, _SurfaceContext scope, _Field f) {
  final value = f.value;
  final String? text;
  if (scope.string(f.component, 'mode') == 'dateRange') {
    final start = formatSurfaceDate(fieldOf(value, 'start'));
    final end = formatSurfaceDate(fieldOf(value, 'end'));
    text = start == null && end == null
        ? null
        : '${start ?? '…'} – ${end ?? '…'}';
  } else {
    text = formatSurfaceDate(value);
  }
  return _ValueBox(label: f.label, text: text, placeholder: f.placeholder);
}

class _RatingValue extends StatelessWidget {
  final _Field field;
  const _RatingValue({required this.field});

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    final scale = (scope.number(field.component, 'scale', field.scope) ?? 5)
        .round()
        .clamp(2, 10);
    final current = asInt(field.value) ?? 0;
    final colors = context.colors;
    return Semantics(
      label: field.label,
      value: current == 0 ? 'Not rated' : '$current of $scale',
      readOnly: true,
      excludeSemantics: true,
      child: Wrap(
        spacing: Grid.half,
        children: [
          for (var index = 1; index <= scale; index++)
            scale == 5
                ? Icon(
                    BuzzIcons.star,
                    size: 20,
                    color: index <= current
                        ? context.appColors.warning
                        : colors.onSurfaceVariant,
                  )
                : Container(
                    width: 28,
                    height: 28,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: index == current
                          ? colors.primary.withValues(alpha: 0.2)
                          : colors.surfaceContainerHighest,
                    ),
                    child: Text('$index', style: _small(context)),
                  ),
        ],
      ),
    );
  }
}
