part of '../hosted_agents_page.dart';

/// Owner-facing text for a management failure, with its support id.
String _managementErrorText(Object error) {
  if (error is! HostedAgentException) return describeHostedAgentError('');
  final supportId = error.supportId;
  return supportId == null
      ? error.message
      : '${error.message} Support ID: $supportId';
}

/// Show one agent's details and actions; "Edit" closes the sheet and opens
/// the edit form on the agent's newest state.
Future<void> _openAgent(
  BuildContext context,
  WidgetRef ref,
  HostedAgentSnapshot agent,
) async {
  final edit = await showBuzzModalBottomSheet<bool>(
    context: context,
    title: agent.displayName,
    isScrollControlled: true,
    builder: (_) => _AgentDetailSheet(
      providerAgentId: agent.providerAgentId,
      fallback: agent,
    ),
  );
  if (edit != true || !context.mounted) return;
  final latest =
      ref.read(hostedAgentListProvider.notifier).find(agent.providerAgentId) ??
      agent;
  final saved = await Navigator.of(context).push<HostedAgentSnapshot>(
    MaterialPageRoute(builder: (_) => HostedAgentCreatePage(existing: latest)),
  );
  if (saved == null || !context.mounted) return;
  ScaffoldMessenger.of(context).showSnackBar(
    SnackBar(
      content: Text('${saved.displayName} saved. It picks up the change now.'),
    ),
  );
}

Future<bool> _confirmDelete(BuildContext context, String name) async {
  final confirmed = await showDialog<bool>(
    context: context,
    builder: (dialogContext) => AlertDialog.adaptive(
      title: Text('Delete $name?'),
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
          child: Text('Delete', style: TextStyle(color: context.colors.error)),
        ),
      ],
    ),
  );
  return confirmed == true;
}
