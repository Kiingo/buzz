part of '../guest_shared_page.dart';

class _SharedRow extends HookConsumerWidget {
  const _SharedRow({super.key, required this.item, required this.agentLabel});

  final GuestShareable item;
  final String agentLabel;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final busy = useState(false);
    final until = formatShortDate(item.expiresAt);
    final meta = [
      shareableKindLabel(item.resourceKind),
      agentLabel,
      if (until.isNotEmpty) 'until $until',
    ].join(' · ');

    Future<void> remove() async {
      busy.value = true;
      await runGuestOwnerAction(
        context,
        ref,
        (client) => client.removeShareable(item.shareableId),
        done: 'No longer shared.',
      );
      if (context.mounted) busy.value = false;
    }

    return Padding(
      padding: EdgeInsets.symmetric(
        horizontal: AppListInset.of(context),
        vertical: Grid.twelve,
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  meta,
                  style: context.textTheme.labelMedium?.copyWith(
                    color: context.colors.onSurfaceVariant,
                  ),
                ),
                const SizedBox(height: Grid.half),
                Text(
                  item.content ?? item.resourceId ?? '',
                  style: context.textTheme.bodyMedium,
                ),
              ],
            ),
          ),
          const SizedBox(width: Grid.xxs),
          OutlinedButton(
            onPressed: busy.value ? null : () => unawaited(remove()),
            child: const Text('Stop sharing'),
          ),
        ],
      ),
    );
  }
}
