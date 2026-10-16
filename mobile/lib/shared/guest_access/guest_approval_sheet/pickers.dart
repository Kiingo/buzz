part of '../guest_approval_sheet.dart';

class _OptionTile extends StatelessWidget {
  const _OptionTile({
    super.key,
    required this.selected,
    required this.enabled,
    required this.control,
    required this.title,
    this.subtitle,
    this.onTap,
  });

  final bool selected;
  final bool enabled;
  final Widget control;
  final Widget title;
  final String? subtitle;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Padding(
      padding: const EdgeInsets.only(bottom: Grid.half),
      child: Opacity(
        opacity: enabled ? 1 : 0.5,
        child: Material(
          color: selected
              ? colors.primary.withValues(alpha: 0.06)
              : Colors.transparent,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(Radii.lg),
            side: BorderSide(
              color: selected
                  ? colors.primary.withValues(alpha: 0.5)
                  : colors.outlineVariant,
            ),
          ),
          child: InkWell(
            borderRadius: BorderRadius.circular(Radii.lg),
            onTap: enabled ? onTap : null,
            child: Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: Grid.xxs,
                vertical: Grid.half,
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  control,
                  const SizedBox(width: Grid.half),
                  Expanded(
                    child: Padding(
                      padding: const EdgeInsets.symmetric(vertical: Grid.xxs),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          title,
                          if (subtitle != null)
                            Text(
                              subtitle!,
                              style: context.textTheme.bodySmall?.copyWith(
                                color: colors.onSurfaceVariant,
                              ),
                            ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// What an owner-data approval releases. When the request named its sources
/// they start checked and the owner may only narrow the list; when it named
/// none, nothing starts checked and the owner must pick at least one. Each
/// source says what it exposes.
class _SourcesToSharePicker extends StatelessWidget {
  const _SourcesToSharePicker({
    required this.agentName,
    required this.enabled,
    required this.mustChoose,
    required this.sources,
    required this.selected,
    required this.onChanged,
  });

  final String agentName;
  final bool enabled;
  final bool mustChoose;
  final List<String> sources;
  final List<String> selected;
  final ValueChanged<List<String>> onChanged;

  @override
  Widget build(BuildContext context) {
    final chosen = selected.toSet();
    void toggle(String source) {
      onChanged(
        chosen.contains(source)
            ? [
                for (final value in selected)
                  if (value != source) value,
              ]
            : [
                for (final value in sources)
                  if (value == source || chosen.contains(value)) value,
              ],
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        _SectionLabel(
          mustChoose ? 'Choose what to share' : "What you're sharing",
        ),
        Padding(
          padding: const EdgeInsets.only(bottom: Grid.xxs),
          child: Text(
            mustChoose
                ? "They didn't say exactly what they need. Pick what $agentName may use to answer."
                : "Approving lets $agentName answer once more using only what's checked. Uncheck anything you'd rather not share.",
            style: context.textTheme.bodySmall?.copyWith(
              color: context.colors.onSurfaceVariant,
            ),
          ),
        ),
        for (final source in sources)
          _OptionTile(
            key: ValueKey('guest-share-source-$source'),
            selected: chosen.contains(source),
            enabled: enabled,
            onTap: () => toggle(source),
            control: Checkbox(
              value: chosen.contains(source),
              onChanged: enabled ? (_) => toggle(source) : null,
            ),
            title: Row(
              children: [
                Icon(
                  BuzzIcons.lock,
                  size: 14,
                  color: context.appColors.warning,
                ),
                const SizedBox(width: Grid.half),
                Flexible(child: Text(dataSourceLabel(source))),
              ],
            ),
            subtitle: dataSourceDescription(source),
          ),
        if (selected.isEmpty)
          Text(
            'Choose at least one to approve, or deny the request.',
            style: context.textTheme.bodySmall?.copyWith(
              color: context.appColors.warning,
            ),
          ),
      ],
    );
  }
}

/// Grant-scope picker: once, thread, N days, kind of question, always.
/// Grants are tied to a linked account, so an unlinked person can only be
/// approved once.
class _GrantScopePicker extends StatelessWidget {
  const _GrantScopePicker({
    required this.enabled,
    required this.requesterName,
    required this.requesterLinked,
    required this.value,
    required this.onChanged,
  });

  final bool enabled;
  final String requesterName;
  final bool requesterLinked;
  final GrantChoice value;
  final ValueChanged<GrantChoice> onChanged;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        const _SectionLabel('Also allow next time'),
        RadioGroup<GrantScope>(
          groupValue: value.scope,
          onChanged: (scope) {
            if (scope != null) onChanged((scope: scope, days: value.days));
          },
          child: Column(
            children: [
              for (final scope in grantScopes)
                _scopeTile(
                  context,
                  scope,
                  scope == GrantScope.once || requesterLinked,
                ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _scopeTile(BuildContext context, GrantScope scope, bool available) {
    final usable = enabled && available;
    return _OptionTile(
      key: ValueKey('guest-grant-scope-${grantScopeToWire(scope)}'),
      selected: value.scope == scope,
      enabled: usable,
      onTap: () => onChanged((scope: scope, days: value.days)),
      control: Radio<GrantScope>(value: scope, enabled: usable),
      title: scope == GrantScope.personDays
          ? Wrap(
              crossAxisAlignment: WrapCrossAlignment.center,
              spacing: Grid.xxs,
              children: [
                Text('$requesterName for'),
                DropdownButton<int>(
                  value: value.days,
                  isDense: true,
                  onChanged: usable
                      ? (days) {
                          if (days != null) {
                            onChanged((
                              scope: GrantScope.personDays,
                              days: days,
                            ));
                          }
                        }
                      : null,
                  items: [
                    for (final days in grantDayOptions)
                      DropdownMenuItem(
                        value: days,
                        child: Text('$days ${days == 1 ? 'day' : 'days'}'),
                      ),
                  ],
                ),
              ],
            )
          : Text(scopeLabel(scope)),
      subtitle: available
          ? scopeHint(scope)
          : "$requesterName hasn't linked their account, so only a one-time approval is possible.",
    );
  }
}
