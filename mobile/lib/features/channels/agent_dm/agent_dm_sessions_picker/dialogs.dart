part of '../agent_dm_sessions_picker.dart';

/// Asks before sending `/new`. True only when the person confirms.
Future<bool> _confirmNewSession(BuildContext context, String agentName) async {
  return await showBuzzDialog<bool>(
        context: context,
        builder: (dialogContext) => AlertDialog.adaptive(
          title: const Text('Start a new session?'),
          content: Text(
            '$agentName ends the current session. Your next message starts '
            'a fresh one.',
          ),
          actions: [
            TextButton(
              key: const ValueKey('agent-dm-new-cancel'),
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              key: const ValueKey('agent-dm-new-confirm'),
              onPressed: () => Navigator.of(dialogContext).pop(true),
              child: const Text('New session'),
            ),
          ],
        ),
      ) ==
      true;
}

/// Asks before sending `/sessions load`. Returns whether to ask for a
/// catch-up note, or null when the person cancels.
Future<bool?> _confirmLoadSession(
  BuildContext context,
  AgentDmSessionItem item,
) {
  return showBuzzDialog<bool>(
    context: context,
    builder: (_) => _LoadSessionDialog(item: item),
  );
}

class _LoadSessionDialog extends HookWidget {
  final AgentDmSessionItem item;

  const _LoadSessionDialog({required this.item});

  @override
  Widget build(BuildContext context) {
    final catchUp = useState(false);
    return AlertDialog.adaptive(
      title: const Text('Load this session?'),
      content: Material(
        type: MaterialType.transparency,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(agentDmSessionTitle(item)),
            const SizedBox(height: Grid.xxs),
            SwitchListTile.adaptive(
              key: const ValueKey('agent-dm-load-catchup'),
              contentPadding: EdgeInsets.zero,
              value: catchUp.value,
              onChanged: (value) => catchUp.value = value,
              title: const Text('Catch me up'),
              subtitle: const Text('Add a short note on what happened since'),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          key: const ValueKey('agent-dm-load-cancel'),
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          key: const ValueKey('agent-dm-load-confirm'),
          onPressed: () => Navigator.of(context).pop(catchUp.value),
          child: const Text('Load'),
        ),
      ],
    );
  }
}
