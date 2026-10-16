part of '../guest_blocks_page.dart';

class _BlockRow extends HookConsumerWidget {
  const _BlockRow({super.key, required this.block, required this.agentLabel});

  final GuestBlock block;
  final String agentLabel;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final busy = useState(false);
    final name = requesterLabel(
      GuestRequester(pubkey: block.pubkey, displayName: block.displayName),
    );
    final details = [
      agentLabel,
      if (formatShortDate(block.createdAt) case final since
          when since.isNotEmpty)
        'since $since',
      ?block.reason,
    ].join(' · ');

    Future<void> unblock() async {
      busy.value = true;
      await runGuestOwnerAction(
        context,
        ref,
        (client) => client.unblock(block.blockId),
        done: '$name is unblocked.',
      );
      if (context.mounted) busy.value = false;
    }

    return Padding(
      padding: EdgeInsets.symmetric(
        horizontal: AppListInset.of(context),
        vertical: Grid.twelve,
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(name, style: context.textTheme.bodyLarge),
                const SizedBox(height: Grid.half),
                Text(
                  details,
                  style: context.textTheme.bodySmall?.copyWith(
                    color: context.colors.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: Grid.xxs),
          OutlinedButton(
            key: const ValueKey('guest-block-remove'),
            onPressed: busy.value ? null : () => unawaited(unblock()),
            child: const Text('Unblock'),
          ),
        ],
      ),
    );
  }
}
