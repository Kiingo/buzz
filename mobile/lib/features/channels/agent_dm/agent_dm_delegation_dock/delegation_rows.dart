part of '../agent_dm_delegation_dock.dart';

/// "3 running · 1 needs you · $4.10 today" and Stop all (§10.1).
class _BoardHeader extends StatelessWidget {
  final String text;
  final bool needsYou;
  final bool canStopAll;
  final VoidCallback onStopAll;

  const _BoardHeader({
    required this.text,
    required this.needsYou,
    required this.canStopAll,
    required this.onStopAll,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Row(
      key: const ValueKey('agent-dm-delegation-header'),
      children: [
        Expanded(
          child: Semantics(
            liveRegion: true,
            child: Text(
              text,
              style: context.textTheme.labelMedium?.copyWith(
                color: needsYou ? colors.primary : colors.onSurfaceVariant,
                fontWeight: needsYou ? FontWeight.w600 : null,
              ),
            ),
          ),
        ),
        if (canStopAll)
          TextButton(
            key: const ValueKey('agent-dm-delegation-stop-all'),
            onPressed: onStopAll,
            child: const Text('Stop all'),
          ),
      ],
    );
  }
}

/// One compact delegation card: title, state, harness, elapsed, cost and
/// the latest progress line. It updates in place.
class _DelegationCardRow extends StatelessWidget {
  final DelegationCard card;
  final String? elapsed;
  final VoidCallback onStop;

  const _DelegationCardRow({
    super.key,
    required this.card,
    required this.elapsed,
    required this.onStop,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final state = delegationStateLabel(card);
    final meta = [
      state,
      ?delegationHarnessLabel(card.harness),
      ?elapsed,
      ?formatDelegationUsd(card.costUsd),
    ].join(' · ');
    final alert =
        card.stalled ||
        card.state == DelegationState.failed ||
        card.state == DelegationState.blocked;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: Grid.half),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Semantics(
              container: true,
              label: '${card.title}, $meta',
              excludeSemantics: true,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    card.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: context.textTheme.bodyMedium?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  Text(
                    meta,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: context.textTheme.labelSmall?.copyWith(
                      color: card.needsYou
                          ? colors.primary
                          : alert
                          ? colors.error
                          : colors.onSurfaceVariant,
                    ),
                  ),
                  if (card.lastProgressLine != null)
                    Text(
                      card.lastProgressLine!,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: context.textTheme.labelSmall?.copyWith(
                        color: colors.onSurfaceVariant,
                      ),
                    ),
                ],
              ),
            ),
          ),
          IconButton(
            tooltip: 'Stop ${card.title}',
            visualDensity: VisualDensity.compact,
            icon: const Icon(BuzzIcons.x, size: 16),
            onPressed: onStop,
          ),
        ],
      ),
    );
  }
}

/// "3 workers running ▸": the folded running cards (§10.1).
class _FoldedRow extends StatelessWidget {
  final int count;
  final bool expanded;
  final VoidCallback onToggle;

  const _FoldedRow({
    required this.count,
    required this.expanded,
    required this.onToggle,
  });

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      expanded: expanded,
      label: '$count workers running',
      excludeSemantics: true,
      onTap: onToggle,
      child: InkWell(
        key: const ValueKey('agent-dm-delegation-fold'),
        onTap: onToggle,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: Grid.xxs),
          child: Row(
            children: [
              Text(
                '$count workers running',
                style: context.textTheme.bodyMedium?.copyWith(
                  fontWeight: FontWeight.w600,
                ),
              ),
              Icon(
                expanded ? BuzzIcons.chevronDown : BuzzIcons.chevronRight,
                size: 16,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// One finished task: every worker's result, with links into the task
/// (Kiingo Tasks) and each worker's session (the web app). Worker
/// transcripts never show here.
class _DoneSummaryRow extends StatelessWidget {
  final DelegationTaskSummary summary;
  final String? appOrigin;
  final Future<void> Function(String url) onOpen;
  final VoidCallback onHide;

  const _DoneSummaryRow({
    super.key,
    required this.summary,
    required this.appOrigin,
    required this.onOpen,
    required this.onHide,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final taskId = summary.taskId;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: Grid.half),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  summary.heading,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: context.textTheme.bodyMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              if (taskId != null)
                TextButton(
                  onPressed: () => onOpen(delegationTaskLink(taskId)),
                  child: const Text('Open task'),
                ),
              IconButton(
                tooltip: 'Hide ${summary.heading}',
                visualDensity: VisualDensity.compact,
                icon: const Icon(BuzzIcons.x, size: 16),
                onPressed: onHide,
              ),
            ],
          ),
          for (final card in summary.workers)
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Text(
                    '${card.title}: ${card.result?.summary ?? (card.state == DelegationState.cancelled ? 'Stopped.' : delegationStateLabel(card))}',
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: context.textTheme.labelSmall?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                ),
                if (appOrigin != null && card.workerSessionId != null)
                  Semantics(
                    button: true,
                    label: 'Open the session for ${card.title}',
                    excludeSemantics: true,
                    onTap: () => onOpen(
                      delegationSessionLink(appOrigin!, card.workerSessionId!),
                    ),
                    child: InkWell(
                      onTap: () => onOpen(
                        delegationSessionLink(
                          appOrigin!,
                          card.workerSessionId!,
                        ),
                      ),
                      child: Padding(
                        padding: const EdgeInsets.only(left: Grid.xxs),
                        child: Text(
                          'Session',
                          style: context.textTheme.labelSmall?.copyWith(
                            color: colors.primary,
                          ),
                        ),
                      ),
                    ),
                  ),
              ],
            ),
        ],
      ),
    );
  }
}
