part of '../settings_page.dart';

/// Entry to the owner's agents, shown only when the build configures a
/// hosted-agent API for the active community.
class _AgentsSection extends ConsumerWidget {
  const _AgentsSection({required this.agentsPageBuilder});

  final WidgetBuilder agentsPageBuilder;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (ref.watch(hostedAgentClientProvider) == null) {
      return const SizedBox.shrink();
    }
    return AppListCard(
      label: 'Agents',
      verticalPadding: Grid.twelve,
      children: [
        AppListRow(
          key: const ValueKey('settings-agents-row'),
          icon: BuzzIcons.bot,
          title: 'Your agents',
          subtitle: 'Create and manage hosted agents',
          trailing: const _RowChevron(),
          onTap: () => Navigator.of(
            context,
          ).push(MaterialPageRoute<void>(builder: agentsPageBuilder)),
        ),
      ],
    );
  }
}
