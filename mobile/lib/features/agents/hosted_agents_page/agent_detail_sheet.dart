part of '../hosted_agents_page.dart';

class _AgentDetailSheet extends HookConsumerWidget {
  const _AgentDetailSheet({
    required this.providerAgentId,
    required this.fallback,
  });

  final String providerAgentId;

  /// Shown until (or unless) the live list has this agent.
  final HostedAgentSnapshot fallback;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final busy = useState<String?>(null);
    final error = useState<String?>(null);
    ref.watch(hostedAgentListProvider);
    final agent =
        ref.read(hostedAgentListProvider.notifier).find(providerAgentId) ??
        fallback;
    final catalog = ref.watch(hostedAgentCatalogProvider).value;
    final labels = hostedProfileLabels(catalog, agent.providerConfig);

    Future<void> run(String label, Future<void> Function() action) async {
      if (busy.value != null) return;
      unawaited(HapticFeedback.selectionClick());
      busy.value = label;
      error.value = null;
      try {
        await action();
      } catch (failure) {
        if (context.mounted) error.value = _managementErrorText(failure);
      } finally {
        if (context.mounted) busy.value = null;
      }
    }

    Future<void> control(String label, HostedAgentAction action) => run(
      label,
      () async {
        await ref.read(hostedAgentListProvider.notifier).control(agent, action);
      },
    );

    Future<void> delete() async {
      if (!await _confirmDelete(context, agent.printableName)) return;
      if (!context.mounted) return;
      await run('delete', () async {
        final warning = await ref
            .read(hostedAgentListProvider.notifier)
            .delete(agent);
        ref.invalidate(ownedAgentsProvider);
        if (!context.mounted) return;
        final messenger = ScaffoldMessenger.of(context);
        Navigator.of(context).pop(false);
        messenger.showSnackBar(
          SnackBar(content: Text(warning ?? '${agent.printableName} deleted.')),
        );
      });
    }

    final lastReady = agent.lastReadyAt;
    final working = busy.value;
    String actionTitle(String key, String idle, String active) =>
        working == key ? active : idle;

    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.only(bottom: Grid.xs),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            AppListCard(
              verticalPadding: 0,
              children: [
                AppListRow(title: 'Status', value: _stateLabel(agent)),
                if (labels.harness case final harness?)
                  AppListRow(title: 'Harness', value: harness),
                if (labels.model case final model?)
                  AppListRow(title: 'Model', value: model),
                if (lastReady != null)
                  AppListRow(
                    title: 'Last ready',
                    value: DateFormat.yMMMd().add_jm().format(
                      lastReady.toLocal(),
                    ),
                  ),
                if (agent.errorCode case final code?)
                  AppListRow(
                    title: 'Last error',
                    subtitle: code,
                    subtitleMaxLines: 2,
                  ),
              ],
            ),
            if (error.value case final message?)
              Padding(
                padding: const EdgeInsets.fromLTRB(
                  Grid.gutter,
                  Grid.xxs,
                  Grid.gutter,
                  0,
                ),
                child: Text(
                  message,
                  style: context.textTheme.bodySmall?.copyWith(
                    color: context.colors.error,
                  ),
                ),
              ),
            const SizedBox(height: Grid.xs),
            if (!agent.isDeleted)
              AppListCard(
                verticalPadding: 0,
                children: [
                  AppListRow(
                    key: const ValueKey('hosted-agent-edit'),
                    icon: BuzzIcons.pencil,
                    title: 'Edit',
                    subtitle: 'Name, instructions, harness and model',
                    onTap: working == null
                        ? () => Navigator.of(context).pop(true)
                        : null,
                  ),
                  if (agent.isPaused)
                    AppListRow(
                      key: const ValueKey('hosted-agent-resume'),
                      icon: BuzzIcons.play,
                      title: actionTitle('resume', 'Resume', 'Resuming…'),
                      onTap: working == null
                          ? () => unawaited(
                              control('resume', HostedAgentAction.resume),
                            )
                          : null,
                    )
                  else
                    AppListRow(
                      key: const ValueKey('hosted-agent-pause'),
                      icon: BuzzIcons.pause,
                      title: actionTitle('pause', 'Pause', 'Pausing…'),
                      subtitle: 'Stops answering until you resume it',
                      onTap: working == null
                          ? () => unawaited(
                              control('pause', HostedAgentAction.pause),
                            )
                          : null,
                    ),
                  AppListRow(
                    key: const ValueKey('hosted-agent-status'),
                    icon: BuzzIcons.refreshCw,
                    title: actionTitle('status', 'Check status', 'Checking…'),
                    onTap: working == null
                        ? () => unawaited(
                            control('status', HostedAgentAction.status),
                          )
                        : null,
                  ),
                  AppListRow(
                    key: const ValueKey('hosted-agent-reconcile'),
                    icon: BuzzIcons.wrench,
                    title: actionTitle(
                      'reconcile',
                      'Reconcile',
                      'Reconciling…',
                    ),
                    subtitle: 'Re-apply its settings if it seems stuck',
                    onTap: working == null
                        ? () => unawaited(
                            control('reconcile', HostedAgentAction.reconcile),
                          )
                        : null,
                  ),
                ],
              ),
            const SizedBox(height: Grid.xs),
            AppListCard(
              verticalPadding: 0,
              children: [
                AppListRow(
                  key: const ValueKey('hosted-agent-delete'),
                  icon: BuzzIcons.trash2,
                  title: actionTitle('delete', 'Delete agent', 'Deleting…'),
                  titleColor: context.colors.error,
                  onTap: working == null ? () => unawaited(delete()) : null,
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
