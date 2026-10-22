part of '../hosted_agent_create_page.dart';

/// "Bring an existing agent": the owner's agents that have no Buzz identity
/// yet. Picking one attaches the new Buzz identity to it instead of creating
/// a new agent; "New agent" (the default) creates one. Hidden when the owner
/// has no such agents, which is the usual case.
class _AttachSection extends StatelessWidget {
  const _AttachSection({
    required this.agents,
    required this.failed,
    required this.onRetry,
    required this.selected,
    required this.enabled,
    required this.onChanged,
  });

  final List<HostedUnlinkedAgent> agents;

  /// The list could not be loaded; say so rather than hide the choice.
  final bool failed;
  final VoidCallback onRetry;

  /// The picked agent's id, or `null` for a new agent.
  final String? selected;
  final bool enabled;
  final ValueChanged<String?> onChanged;

  @override
  Widget build(BuildContext context) {
    if (failed) {
      return Padding(
        padding: const EdgeInsets.fromLTRB(
          Grid.gutter + Grid.xxs,
          Grid.xs,
          Grid.gutter,
          0,
        ),
        child: Row(
          children: [
            Expanded(
              child: Text(
                "Couldn't load your existing agents, so this creates a new one.",
                style: context.textTheme.bodySmall?.copyWith(
                  color: context.colors.onSurfaceVariant,
                ),
              ),
            ),
            TextButton(
              key: const ValueKey('hosted-attach-retry'),
              onPressed: enabled ? onRetry : null,
              child: const Text('Try again'),
            ),
          ],
        ),
      );
    }
    if (agents.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        AppListCard(
          label: 'Agent',
          verticalPadding: Grid.twelve,
          children: [
            _AttachChoiceRow(
              key: const ValueKey('hosted-attach-new'),
              label: 'New agent',
              selected: selected == null,
              enabled: enabled,
              onTap: () => onChanged(null),
            ),
            for (final agent in agents)
              _AttachChoiceRow(
                key: ValueKey('hosted-attach-${agent.kiingoAgentId}'),
                label: agent.displayName,
                detail: agent.organizationOwned ? 'Organization' : null,
                selected: selected == agent.kiingoAgentId,
                enabled: enabled,
                onTap: () => onChanged(agent.kiingoAgentId),
              ),
          ],
        ),
        _Caption(
          selected == null
              ? "Or bring one of your agents that isn't on Buzz yet."
              : 'Brings this agent to Buzz. It keeps its own name, '
                    'instructions and settings.',
        ),
      ],
    );
  }
}

class _AttachChoiceRow extends StatelessWidget {
  const _AttachChoiceRow({
    super.key,
    required this.label,
    required this.selected,
    required this.enabled,
    required this.onTap,
    this.detail,
  });

  final String label;
  final String? detail;
  final bool selected;
  final bool enabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    // One stop per choice: the row owns its label, selected state and tap.
    return MergeSemantics(
      child: Semantics(
        button: true,
        inMutuallyExclusiveGroup: true,
        selected: selected,
        enabled: enabled,
        child: InkWell(
          onTap: enabled ? onTap : null,
          child: Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: Grid.xs,
              vertical: Grid.twelve,
            ),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(label, style: context.textTheme.bodyLarge),
                      if (detail case final detail?)
                        Text(
                          detail,
                          style: context.textTheme.bodySmall?.copyWith(
                            color: context.colors.onSurfaceVariant,
                          ),
                        ),
                    ],
                  ),
                ),
                if (selected)
                  ExcludeSemantics(
                    child: Icon(
                      BuzzIcons.check,
                      size: 18,
                      color: context.colors.primary,
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
