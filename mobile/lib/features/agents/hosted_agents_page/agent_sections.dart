part of '../hosted_agents_page.dart';

class _HostedSection extends ConsumerWidget {
  const _HostedSection({required this.agents, required this.onCreate});

  final AsyncValue<List<HostedAgentSnapshot>> agents;
  final VoidCallback onCreate;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final catalog = ref.watch(hostedAgentCatalogProvider).value;
    final List<Widget> rows;
    if (agents.hasValue) {
      // Pending agents are listed (with Link) in the section above.
      final list = [
        for (final agent in agents.requireValue)
          if (!agent.isPendingAttestation) agent,
      ];
      final owner = ref
          .read(hostedAgentListProvider.notifier)
          .currentOwnerPublicKey();
      final stale = owner == null
          ? const <String>{}
          : {
              for (final agent in staleHostedAgents(list, owner))
                agent.providerAgentId,
            };
      rows = list.isEmpty
          ? [
              AppListRow(
                key: const ValueKey('hosted-agents-empty'),
                icon: BuzzIcons.plus,
                title: 'New agent',
                subtitle: 'Runs in the cloud and answers you in Buzz.',
                onTap: onCreate,
              ),
            ]
          : [
              for (final agent in list)
                if (stale.contains(agent.providerAgentId))
                  _LinkRow(
                    key: ValueKey('hosted-link-stale-${agent.providerAgentId}'),
                    agent: agent,
                    rebind: true,
                    onOpen: () => unawaited(_openAgent(context, ref, agent)),
                  )
                else
                  AppListRow(
                    key: ValueKey('hosted-agent-${agent.providerAgentId}'),
                    icon: agent.isPaused ? BuzzIcons.pause : BuzzIcons.bot,
                    title: agent.displayName,
                    subtitle: [
                      ?hostedProfileLabels(
                        catalog,
                        agent.providerConfig,
                      ).harness,
                      ?hostedProfileLabels(catalog, agent.providerConfig).model,
                    ].join(' · '),
                    value: _stateLabel(agent),
                    trailing: Icon(
                      BuzzIcons.chevronRight,
                      size: 18,
                      color: context.colors.onSurfaceVariant,
                    ),
                    onTap: () => unawaited(_openAgent(context, ref, agent)),
                  ),
            ];
    } else if (agents.hasError) {
      final error = agents.error;
      rows = [
        AppListRow(
          icon: BuzzIcons.wifiOff,
          title: "Couldn't load your hosted agents",
          subtitle: error is HostedAgentException
              ? error.message
              : 'Pull down to try again.',
          subtitleMaxLines: 3,
          onTap: () =>
              unawaited(ref.read(hostedAgentListProvider.notifier).refresh()),
        ),
      ];
    } else {
      rows = const [AppListRow(title: 'Loading your hosted agents…')];
    }
    return AppListCard(
      label: 'Hosted agents',
      verticalPadding: Grid.twelve,
      children: rows,
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
            icon: BuzzIcons.bot,
            title: agent.name,
            subtitle: 'Manage it in Buzz on desktop',
          ),
      ];
    } else if (value.hasError) {
      rows = const [
        AppListRow(
          icon: BuzzIcons.wifiOff,
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
