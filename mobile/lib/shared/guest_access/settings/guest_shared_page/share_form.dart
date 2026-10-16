part of '../guest_shared_page.dart';

/// The route bounds shared text in UTF-8 bytes.
const _maxShareBytes = 8192;

class _ShareForm extends HookConsumerWidget {
  const _ShareForm();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final kind = useState('status');
    final days = useState<int?>(null);
    final agent = useState<String?>(null);
    final busy = useState(false);
    final controller = useTextEditingController();
    useListenable(controller);
    final agents = ref.watch(ownerGuestAgentsProvider).value ?? const [];
    final text = controller.text.trim();
    final tooLong = utf8.encode(text).length > _maxShareBytes;
    // A per-agent choice whose agent disappeared falls back to all agents.
    final agentValue = agents.any((row) => row.guestEndpointId == agent.value)
        ? agent.value
        : null;

    Future<void> share() async {
      busy.value = true;
      final ok = await runGuestOwnerAction(
        context,
        ref,
        (client) => client.addShareable(
          resourceKind: kind.value,
          content: text,
          guestEndpointId: agentValue,
          expiresInDays: days.value,
        ),
        done: 'Shared via your agents.',
      );
      if (!context.mounted) return;
      busy.value = false;
      if (ok) controller.clear();
    }

    return AppListCard(
      label: 'Share something',
      verticalPadding: Grid.twelve,
      children: [
        Padding(
          padding: EdgeInsets.symmetric(
            horizontal: AppListInset.of(context),
            vertical: Grid.twelve,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              SegmentedButton<String>(
                segments: const [
                  ButtonSegment(value: 'status', label: Text('Status')),
                  ButtonSegment(value: 'note', label: Text('Note or decision')),
                ],
                selected: {kind.value},
                onSelectionChanged: (value) => kind.value = value.first,
              ),
              const SizedBox(height: Grid.xxs),
              TextField(
                key: const ValueKey('guest-shared-content'),
                controller: controller,
                minLines: 2,
                maxLines: 6,
                decoration: InputDecoration(
                  hintText: kind.value == 'status'
                      ? 'Heads down on the Q4 pricing review until Friday.'
                      : 'We decided to move the launch to November 3.',
                  errorText: tooLong ? 'Keep it under 8 KB.' : null,
                ),
              ),
              const SizedBox(height: Grid.xxs),
              DropdownButtonFormField<int?>(
                initialValue: days.value,
                decoration: const InputDecoration(labelText: 'Share for'),
                items: const [
                  DropdownMenuItem(
                    value: null,
                    child: Text('Until I remove it'),
                  ),
                  DropdownMenuItem(value: 1, child: Text('1 day')),
                  DropdownMenuItem(value: 7, child: Text('7 days')),
                  DropdownMenuItem(value: 30, child: Text('30 days')),
                ],
                onChanged: (value) => days.value = value,
              ),
              if (agents.length > 1) ...[
                const SizedBox(height: Grid.xxs),
                DropdownButtonFormField<String?>(
                  initialValue: agentValue,
                  decoration: const InputDecoration(labelText: 'Through'),
                  items: [
                    const DropdownMenuItem(
                      value: null,
                      child: Text('All your agents'),
                    ),
                    for (final row in agents)
                      DropdownMenuItem(
                        value: row.guestEndpointId,
                        child: Text(row.displayName ?? 'Agent'),
                      ),
                  ],
                  onChanged: (value) => agent.value = value,
                ),
              ],
              const SizedBox(height: Grid.twelve),
              Align(
                alignment: Alignment.centerRight,
                child: FilledButton(
                  key: const ValueKey('guest-shared-add'),
                  onPressed: busy.value || text.isEmpty || tooLong
                      ? null
                      : () => unawaited(share()),
                  child: const Text('Share via my agents'),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
