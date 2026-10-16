part of '../guest_requests_page.dart';

class _LogPage extends ConsumerWidget {
  const _LogPage({
    super.key,
    required this.logKey,
    required this.first,
    required this.last,
    required this.blocked,
    required this.onMore,
  });

  final GuestAccessLogKey logKey;
  final bool first;
  final bool last;
  final Set<String> blocked;
  final ValueChanged<String> onMore;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final page = ref.watch(ownerGuestAccessLogProvider(logKey));
    final names = ref.watch(guestAgentNamesProvider);
    return GuestOwnerListState<GuestAccessLogPage>(
      value: page,
      // Only the first page can be empty; later pages just end the list.
      isEmpty: (value) => first && value.items.isEmpty,
      emptyText: 'No guest requests yet.',
      onRetry: () => ref.invalidate(ownerGuestAccessLogProvider(logKey)),
      builder: (value) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (value.items.isNotEmpty)
            AppListCard(
              verticalPadding: Grid.xxs,
              dividerIndent: Grid.xs,
              children: [
                for (final entry in value.items)
                  _RequestRow(
                    key: ValueKey(entry.entryId),
                    entry: entry,
                    agentLabel: logKey.agent == null
                        ? guestAgentScopeLabel(names, entry.guestEndpointId)
                        : null,
                    blocked: blocked.contains(
                      entry.requester.pubkey.toLowerCase(),
                    ),
                  ),
              ],
            ),
          if (last &&
              value.nextCursor != null &&
              value.items.length >= _pageSize)
            Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: Grid.gutter,
                vertical: Grid.xxs,
              ),
              child: OutlinedButton(
                key: const ValueKey('guest-requests-more'),
                onPressed: () => onMore(value.nextCursor!),
                child: const Text('Show older requests'),
              ),
            ),
        ],
      ),
    );
  }
}
