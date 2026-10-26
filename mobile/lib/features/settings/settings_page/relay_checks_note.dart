part of '../settings_page.dart';

/// A diagnostic line above the version: how many events the relay session
/// dropped because they failed its checks. A history page whose events
/// were all dropped looks like the end of history, so this says why.
class _RelayChecksNote extends ConsumerWidget {
  const _RelayChecksNote();

  static const _labels = {
    RelayEventRejection.shape: 'malformed',
    RelayEventRejection.idMismatch: 'altered',
    RelayEventRejection.badSignature: 'badly signed',
  };

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // No session yet means nothing was received, so nothing was dropped.
    if (!ref.exists(relaySessionProvider)) return const SizedBox.shrink();
    // Counts are not session state; a status change refreshes them.
    ref.watch(relaySessionProvider);
    final counts = ref.read(relaySessionProvider.notifier).droppedEventCounts;
    final total = counts.values.fold(0, (sum, count) => sum + count);
    if (total == 0) return const SizedBox.shrink();
    final parts = [
      for (final reason in RelayEventRejection.values)
        if (counts[reason] case final count? when count > 0)
          '$count ${_labels[reason]}',
    ];
    return Padding(
      padding: const EdgeInsets.only(top: Grid.xxs),
      child: Center(
        child: Text(
          'Dropped $total relay ${total == 1 ? 'event' : 'events'} '
          'that failed checks (${parts.join(', ')})',
          textAlign: TextAlign.center,
          style: context.textTheme.bodySmall?.copyWith(
            color: context.colors.onSurfaceVariant.withValues(alpha: 0.6),
          ),
        ),
      ),
    );
  }
}
