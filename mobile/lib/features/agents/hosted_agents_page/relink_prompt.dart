part of '../hosted_agents_page.dart';

/// "Re-link your agents" prompt, shown only while one or more hosted agents
/// are still linked to an earlier owner key. Tapping it opens the review
/// sheet; nothing is signed until the owner confirms there.
class _RelinkPrompt extends HookConsumerWidget {
  const _RelinkPrompt({required this.agents});

  final AsyncValue<List<HostedAgentSnapshot>> agents;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(hostedAgentClientProvider);
    final owner = ref
        .read(hostedAgentListProvider.notifier)
        .currentOwnerPublicKey();
    final list = agents.value;
    if (owner == null || list == null) return const SizedBox.shrink();
    final stale = staleHostedAgents(list, owner);
    if (stale.isEmpty) return const SizedBox.shrink();
    final count = stale.length;
    const label = 'Re-link your agents to your current key';
    final subtitle = count == 1
        ? '${stale.single.displayName} is still linked to your old key.'
        : '$count agents are still linked to your old key.';
    return Padding(
      padding: const EdgeInsets.only(bottom: Grid.sm),
      child: AppListCard(
        verticalPadding: Grid.twelve,
        children: [
          Semantics(
            button: true,
            label: label,
            hint: subtitle,
            excludeSemantics: true,
            onTap: () => unawaited(_openRelink(context, ref, list, owner)),
            child: AppListRow(
              key: const ValueKey('hosted-agents-relink'),
              icon: BuzzIcons.key,
              title: label,
              subtitle: subtitle,
              subtitleMaxLines: 2,
              trailing: Icon(
                BuzzIcons.chevronRight,
                size: 18,
                color: context.colors.onSurfaceVariant,
              ),
              onTap: () => unawaited(_openRelink(context, ref, list, owner)),
            ),
          ),
        ],
      ),
    );
  }
}

Future<void> _openRelink(
  BuildContext context,
  WidgetRef ref,
  List<HostedAgentSnapshot> agents,
  String owner,
) async {
  unawaited(HapticFeedback.selectionClick());
  await showBuzzModalBottomSheet<void>(
    context: context,
    title: 'Re-link agents',
    isScrollControlled: true,
    builder: (_) => _RelinkSheet(
      stale: staleHostedAgents(agents, owner),
      current: currentHostedAgents(agents, owner),
    ),
  );
}
