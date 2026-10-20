part of '../hosted_agents_page.dart';

/// Review and confirm re-linking. Every stale agent starts selected; the
/// owner's tap on the confirm button is the only thing that signs, and it
/// signs only for the agents still selected. A retry is another tap that
/// sends only the retryable agents, with a new request and proof.
class _RelinkSheet extends HookConsumerWidget {
  const _RelinkSheet({required this.stale, required this.current});

  /// Agents linked to an earlier key, as listed when the sheet opened.
  final List<HostedAgentSnapshot> stale;

  /// Agents already linked to the current key; never sent.
  final List<HostedAgentSnapshot> current;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final selected = useState<Set<String>>({
      for (final agent in stale) agent.providerAgentId,
    });
    final outcomes = useState<Map<String, HostedRebindOutcome>>(const {});
    final busy = useState(false);
    final requestError = useState<String?>(null);

    bool selectable(HostedAgentSnapshot agent) {
      final outcome = outcomes.value[agent.providerAgentId];
      return outcome == null || outcome.retryable;
    }

    final chosen = [
      for (final agent in stale)
        if (selectable(agent) && selected.value.contains(agent.providerAgentId))
          agent,
    ];
    final isRetry = outcomes.value.isNotEmpty;
    final finished =
        isRetry &&
        !stale.any(
          (agent) => outcomes.value[agent.providerAgentId]?.retryable != false,
        );

    void toggle(HostedAgentSnapshot agent) {
      if (busy.value || !selectable(agent)) return;
      unawaited(HapticFeedback.selectionClick());
      final next = {...selected.value};
      if (!next.remove(agent.providerAgentId)) next.add(agent.providerAgentId);
      selected.value = next;
    }

    Future<void> confirm() async {
      if (busy.value ||
          chosen.isEmpty ||
          chosen.length > hostedRebindMaxAgents) {
        return;
      }
      unawaited(HapticFeedback.selectionClick());
      busy.value = true;
      requestError.value = null;
      try {
        final results = await ref
            .read(hostedAgentListProvider.notifier)
            .rebindOwnerKey(chosen);
        if (!context.mounted) return;
        outcomes.value = {
          ...outcomes.value,
          for (final outcome in results) outcome.providerAgentId: outcome,
        };
      } on HostedAgentException catch (error) {
        if (context.mounted) {
          requestError.value = describeRebindRequestError(error);
        }
      } catch (_) {
        if (context.mounted) {
          requestError.value = describeHostedAgentError('');
        }
      } finally {
        if (context.mounted) busy.value = false;
      }
    }

    final count = chosen.length;
    final String actionLabel;
    if (busy.value) {
      actionLabel = 'Re-linking…';
    } else if (count > hostedRebindMaxAgents) {
      actionLabel = 'Choose $hostedRebindMaxAgents or fewer';
    } else if (isRetry) {
      actionLabel = count == 1 ? 'Retry 1 agent' : 'Retry $count agents';
    } else {
      actionLabel = count == 1 ? 'Re-link 1 agent' : 'Re-link $count agents';
    }
    final canSend = !busy.value && count > 0 && count <= hostedRebindMaxAgents;

    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.only(bottom: Grid.xs),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(
                Grid.gutter,
                0,
                Grid.gutter,
                Grid.xs,
              ),
              child: Text(
                'Buzz signs one approval with the key you use now for each '
                'agent you choose, so it answers to you again; nothing '
                'else changes.',
                style: context.textTheme.bodyMedium?.copyWith(
                  color: context.colors.onSurfaceVariant,
                ),
              ),
            ),
            AppListCard(
              label: 'Linked to your old key',
              verticalPadding: 0,
              children: [
                for (final agent in stale)
                  _RelinkRow(
                    key: ValueKey('hosted-relink-${agent.providerAgentId}'),
                    agent: agent,
                    selected:
                        selectable(agent) &&
                        selected.value.contains(agent.providerAgentId),
                    enabled: !busy.value && selectable(agent),
                    outcome: outcomes.value[agent.providerAgentId],
                    onToggle: () => toggle(agent),
                  ),
              ],
            ),
            if (current.isNotEmpty) ...[
              const SizedBox(height: Grid.xs),
              AppListCard(
                label: 'Already linked',
                verticalPadding: 0,
                children: [
                  for (final agent in current)
                    AppListRow(
                      key: ValueKey(
                        'hosted-relink-current-${agent.providerAgentId}',
                      ),
                      icon: BuzzIcons.circleCheck,
                      title: agent.displayName,
                      value: 'Already linked',
                    ),
                ],
              ),
            ],
            if (requestError.value case final message?)
              Padding(
                padding: const EdgeInsets.fromLTRB(
                  Grid.gutter,
                  Grid.xxs,
                  Grid.gutter,
                  0,
                ),
                child: Semantics(
                  liveRegion: true,
                  child: Text(
                    message,
                    style: context.textTheme.bodySmall?.copyWith(
                      color: context.colors.error,
                    ),
                  ),
                ),
              ),
            Padding(
              padding: const EdgeInsets.fromLTRB(
                Grid.gutter,
                Grid.xs,
                Grid.gutter,
                0,
              ),
              child: finished
                  ? Semantics(
                      button: true,
                      label: 'Done',
                      excludeSemantics: true,
                      onTap: () => Navigator.of(context).pop(),
                      child: FilledButton(
                        key: const ValueKey('hosted-relink-done'),
                        onPressed: () => Navigator.of(context).pop(),
                        child: const Text('Done'),
                      ),
                    )
                  : Semantics(
                      button: true,
                      enabled: canSend,
                      label: actionLabel,
                      excludeSemantics: true,
                      onTap: canSend ? () => unawaited(confirm()) : null,
                      child: FilledButton(
                        key: const ValueKey('hosted-relink-confirm'),
                        onPressed: canSend ? () => unawaited(confirm()) : null,
                        child: Text(actionLabel),
                      ),
                    ),
            ),
          ],
        ),
      ),
    );
  }
}

/// One agent with its checkbox and, after a request, its outcome.
class _RelinkRow extends HookConsumerWidget {
  const _RelinkRow({
    super.key,
    required this.agent,
    required this.selected,
    required this.enabled,
    required this.outcome,
    required this.onToggle,
  });

  final HostedAgentSnapshot agent;
  final bool selected;
  final bool enabled;
  final HostedRebindOutcome? outcome;
  final VoidCallback onToggle;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final result = outcome;
    final failed =
        result != null && result.status == HostedRebindStatus.rejected;
    return Semantics(
      container: true,
      checked: result == null || result.retryable ? selected : null,
      enabled: enabled,
      label: agent.displayName,
      value: result?.label,
      excludeSemantics: true,
      onTap: enabled ? onToggle : null,
      child: AppListRowRaw(
        leading: result == null || result.retryable
            ? Checkbox(
                value: selected,
                onChanged: enabled ? (_) => onToggle() : null,
              )
            : Icon(
                failed ? BuzzIcons.circleAlert : BuzzIcons.circleCheck,
                size: 22,
                color: failed
                    ? context.colors.error
                    : context.colors.onSurfaceVariant,
              ),
        title: Text(agent.displayName, style: context.textTheme.bodyLarge),
        subtitle: result == null
            ? null
            : Text(
                result.label,
                style: context.textTheme.bodySmall?.copyWith(
                  color: failed
                      ? context.colors.error
                      : context.colors.onSurfaceVariant,
                ),
              ),
        onTap: enabled ? onToggle : null,
      ),
    );
  }
}
