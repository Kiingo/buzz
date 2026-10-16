part of '../hosted_agents_page.dart';

class _HostedSection extends StatelessWidget {
  const _HostedSection({required this.records, required this.onCreate});

  final List<HostedAgentRecord> records;
  final VoidCallback onCreate;

  @override
  Widget build(BuildContext context) {
    final sorted = [...records]
      ..sort((a, b) => b.createdAt.compareTo(a.createdAt));
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        AppListCard(
          label: 'Hosted agents from this phone',
          verticalPadding: Grid.twelve,
          children: [
            if (sorted.isEmpty)
              AppListRow(
                key: const ValueKey('hosted-agents-empty'),
                icon: LucideIcons.plus,
                title: 'New agent',
                subtitle: 'Runs in the cloud and answers you in Buzz.',
                onTap: onCreate,
              )
            else
              for (final record in sorted)
                AppListRow(
                  key: ValueKey('hosted-agent-${record.pubkey}'),
                  icon: LucideIcons.bot,
                  title: record.displayName,
                  subtitle: [
                    record.destination,
                    ?record.harness,
                    ?record.model,
                  ].where((part) => part.isNotEmpty).join(' · '),
                  value: _stateLabel(record.observedState),
                  trailing: Icon(
                    LucideIcons.chevronRight,
                    size: 18,
                    color: context.colors.onSurfaceVariant,
                  ),
                  onTap: () => unawaited(
                    showBuzzModalBottomSheet<void>(
                      context: context,
                      title: record.displayName,
                      isScrollControlled: true,
                      builder: (_) => _AgentDetailSheet(record: record),
                    ),
                  ),
                ),
          ],
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(
            Grid.gutter + Grid.xxs,
            Grid.xxs,
            Grid.gutter + Grid.xxs,
            0,
          ),
          child: Text(
            'You can delete these here. Starting, stopping and editing a '
            "hosted agent isn't available on the phone yet.",
            style: context.textTheme.bodySmall?.copyWith(
              color: context.colors.onSurfaceVariant,
            ),
          ),
        ),
      ],
    );
  }
}

class _OtherAgentsSection extends StatelessWidget {
  const _OtherAgentsSection({required this.agents});

  final AsyncValue<List<OwnedAgentSummary>> agents;

  @override
  Widget build(BuildContext context) {
    final value = agents;
    final List<Widget> rows;
    if (value.hasValue) {
      final list = value.requireValue;
      if (list.isEmpty) return const SizedBox.shrink();
      rows = [
        for (final agent in list)
          AppListRow(
            key: ValueKey('owned-agent-${agent.pubkey}'),
            icon: LucideIcons.bot,
            title: agent.name,
            subtitle: 'Manage it in Buzz on desktop',
          ),
      ];
    } else if (value.hasError) {
      rows = const [
        AppListRow(
          icon: LucideIcons.wifiOff,
          title: "Couldn't load your other agents",
          subtitle: 'Pull down to try again.',
        ),
      ];
    } else {
      rows = const [AppListRow(title: 'Loading your other agents…')];
    }
    return AppListCard(
      label: 'Your other agents',
      verticalPadding: Grid.twelve,
      children: rows,
    );
  }
}
