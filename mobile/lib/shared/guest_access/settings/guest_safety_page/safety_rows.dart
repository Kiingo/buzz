part of '../guest_safety_page.dart';

class _AlertRow extends HookConsumerWidget {
  const _AlertRow({super.key, required this.alert});

  final GuestAdminAlert alert;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final busy = useState(false);
    final name = _personName(ref, alert.requesterPubkey);

    Future<void> acknowledge() async {
      busy.value = true;
      await runGuestOwnerAction(
        context,
        ref,
        (client) => client.acknowledgeAdminAlert(alert.alertId),
        done: 'Marked reviewed.',
      );
      if (context.mounted) busy.value = false;
    }

    return Padding(
      padding: EdgeInsets.symmetric(
        horizontal: AppListInset.of(context),
        vertical: Grid.twelve,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Wrap(
            spacing: Grid.xxs,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              GuestBadge(
                label: adminAlertBadge(alert),
                tone: alert.severity == 'high'
                    ? GuestTone.danger
                    : GuestTone.neutral,
              ),
              Text(
                formatShortDate(alert.createdAt),
                style: context.textTheme.bodySmall?.copyWith(
                  color: context.colors.onSurfaceVariant,
                ),
              ),
            ],
          ),
          const SizedBox(height: Grid.half),
          Text(
            adminAlertText(alert, name),
            style: context.textTheme.bodyMedium,
          ),
          Align(
            alignment: Alignment.centerRight,
            child: OutlinedButton(
              key: const ValueKey('guest-safety-alert-ack'),
              onPressed: busy.value ? null : () => unawaited(acknowledge()),
              child: const Text('Mark reviewed'),
            ),
          ),
        ],
      ),
    );
  }
}

class _SuspendedRow extends HookConsumerWidget {
  const _SuspendedRow({super.key, required this.person});

  final GuestSuspendedRequester person;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final busy = useState(false);
    final name = _personName(ref, person.pubkey);
    final since = formatShortDate(person.suspendedAt);
    final details = [
      if (since.isNotEmpty) 'Suspended $since' else 'Suspended',
      if (person.reason != null) suspensionReasonText(person.reason!),
    ].join(' · ');

    Future<void> restore() async {
      final confirmed = await confirmGuestOwnerAction(
        context,
        title: 'Restore $name?',
        message:
            '$name will be able to ask colleagues\' agents again. Their '
            'requests still go through the usual safety checks.',
        confirmLabel: 'Restore access',
        destructive: false,
      );
      if (!confirmed || !context.mounted) return;
      busy.value = true;
      await runGuestOwnerAction(
        context,
        ref,
        (client) => client.restoreRequester(person.pubkey),
        done: 'Access restored.',
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
            key: const ValueKey('guest-safety-restore'),
            onPressed: busy.value ? null : () => unawaited(restore()),
            child: const Text('Restore access'),
          ),
        ],
      ),
    );
  }
}
