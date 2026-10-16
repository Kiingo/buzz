part of '../hosted_agents_page.dart';

class _AgentDetailSheet extends HookConsumerWidget {
  const _AgentDetailSheet({required this.record});

  final HostedAgentRecord record;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final deleting = useState(false);
    final error = useState<String?>(null);

    Future<void> delete() async {
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (dialogContext) => AlertDialog.adaptive(
          title: Text('Delete ${record.displayName}?'),
          content: const Text(
            'The agent stops for good and its identity is destroyed. '
            'Conversations it was part of stay.',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogContext, false),
              child: const Text('Cancel'),
            ),
            TextButton(
              key: const ValueKey('hosted-agent-confirm-delete'),
              onPressed: () => Navigator.pop(dialogContext, true),
              child: Text(
                'Delete',
                style: TextStyle(color: context.colors.error),
              ),
            ),
          ],
        ),
      );
      if (confirmed != true || !context.mounted) return;
      deleting.value = true;
      error.value = null;
      try {
        final catalog = await ref.read(hostedAgentCatalogProvider.future);
        final warning = await ref
            .read(hostedAgentControllerProvider.notifier)
            .delete(catalog: catalog, record: record);
        if (!context.mounted) return;
        ref.invalidate(ownedAgentsProvider);
        final messenger = ScaffoldMessenger.of(context);
        Navigator.of(context).pop();
        messenger.showSnackBar(
          SnackBar(content: Text(warning ?? '${record.displayName} deleted.')),
        );
      } on HostedAgentException catch (failure) {
        if (!context.mounted) return;
        deleting.value = false;
        error.value = failure.supportId == null
            ? failure.message
            : '${failure.message} Support ID: ${failure.supportId}';
      } catch (_) {
        if (!context.mounted) return;
        deleting.value = false;
        error.value = describeHostedAgentError('');
      }
    }

    final created = DateFormat.yMMMd().add_jm().format(
      record.createdAt.toLocal(),
    );
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
                AppListRow(title: 'Runs on', value: record.destination),
                if (record.harness case final harness?)
                  AppListRow(title: 'Harness', value: harness),
                if (record.model case final model?)
                  AppListRow(title: 'Model', value: model),
                AppListRow(
                  title: 'Status when created',
                  value: _stateLabel(record.observedState),
                ),
                AppListRow(title: 'Created', value: created),
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
            AppListCard(
              verticalPadding: 0,
              children: [
                AppListRow(
                  key: const ValueKey('hosted-agent-delete'),
                  icon: LucideIcons.trash2,
                  title: deleting.value ? 'Deleting…' : 'Delete agent',
                  titleColor: context.colors.error,
                  onTap: deleting.value ? null : () => unawaited(delete()),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
