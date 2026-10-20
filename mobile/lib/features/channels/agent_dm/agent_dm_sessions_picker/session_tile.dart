part of '../agent_dm_sessions_picker.dart';

class _SessionList extends StatelessWidget {
  final AgentDmSessionsListing listing;
  final bool enabled;
  final ValueChanged<AgentDmSessionItem> onLoad;

  const _SessionList({
    required this.listing,
    required this.enabled,
    required this.onLoad,
  });

  @override
  Widget build(BuildContext context) {
    if (listing.items.isEmpty) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: Grid.xs),
        child: Text(
          'No earlier sessions yet.',
          key: const ValueKey('agent-dm-sessions-empty'),
          style: context.textTheme.bodySmall,
        ),
      );
    }
    return Flexible(
      child: ListView(
        key: const ValueKey('agent-dm-sessions-list'),
        shrinkWrap: true,
        children: [
          for (final item in listing.items)
            _SessionTile(
              key: ValueKey('agent-dm-session-${item.sessionId}'),
              item: item,
              enabled: enabled,
              onLoad: () => onLoad(item),
            ),
        ],
      ),
    );
  }
}

class _SessionTile extends StatelessWidget {
  final AgentDmSessionItem item;
  final bool enabled;
  final VoidCallback onLoad;

  const _SessionTile({
    super.key,
    required this.item,
    required this.enabled,
    required this.onLoad,
  });

  @override
  Widget build(BuildContext context) {
    final title = agentDmSessionTitle(item);
    final summary = agentDmSessionSummary(item);
    final canLoad = enabled && item.loadable && !item.isCurrent;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: Grid.half),
      child: Row(
        children: [
          Expanded(
            child: Semantics(
              container: true,
              label: '$title. $summary',
              excludeSemantics: true,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: context.textTheme.bodyMedium?.copyWith(
                      fontWeight: item.isCurrent
                          ? FontWeight.w600
                          : FontWeight.normal,
                    ),
                  ),
                  Text(
                    summary,
                    style: context.textTheme.bodySmall?.copyWith(
                      color: context.colors.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ),
          ),
          if (!item.isCurrent) ...[
            const SizedBox(width: Grid.xxs),
            Semantics(
              container: true,
              button: true,
              enabled: canLoad,
              label: 'Load $title',
              hint: item.loadable ? null : "This session can't be loaded",
              excludeSemantics: true,
              onTap: canLoad ? onLoad : null,
              child: OutlinedButton(
                key: ValueKey('agent-dm-session-load-${item.sessionId}'),
                onPressed: canLoad ? onLoad : null,
                child: const Text('Load'),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _TimedOut extends StatelessWidget {
  final String agentName;
  final VoidCallback onRetry;

  const _TimedOut({required this.agentName, required this.onRetry});

  @override
  Widget build(BuildContext context) {
    return Padding(
      key: const ValueKey('agent-dm-sessions-timeout'),
      padding: const EdgeInsets.symmetric(vertical: Grid.xs),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Semantics(
            liveRegion: true,
            child: Text(
              "$agentName didn't answer. Try again in a moment.",
              textAlign: TextAlign.center,
              style: context.textTheme.bodySmall,
            ),
          ),
          const SizedBox(height: Grid.xxs),
          Semantics(
            container: true,
            button: true,
            label: 'Ask again',
            excludeSemantics: true,
            onTap: onRetry,
            child: OutlinedButton(
              key: const ValueKey('agent-dm-sessions-retry'),
              onPressed: onRetry,
              child: const Text('Ask again'),
            ),
          ),
        ],
      ),
    );
  }
}
