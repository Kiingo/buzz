part of '../guest_grants_page.dart';

class _GrantRow extends HookConsumerWidget {
  const _GrantRow({super.key, required this.grant, required this.agentLabel});

  final GuestGrant grant;
  final String agentLabel;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final busy = useState(false);
    final who = grant.grantee.displayName ?? 'Someone';
    final muted = context.textTheme.bodySmall?.copyWith(
      color: context.colors.onSurfaceVariant,
    );

    Future<void> revoke() async {
      final confirmed = await confirmGuestOwnerAction(
        context,
        title: 'Revoke grant?',
        message:
            '$who will need your approval again for answers that use '
            'information only you can see. This takes effect within 10 '
            'minutes.',
        confirmLabel: 'Revoke',
      );
      if (!confirmed || !context.mounted) return;
      busy.value = true;
      await runGuestOwnerAction(
        context,
        ref,
        (client) => client.revokeGrant(grant.grantId),
        done: 'Grant revoked.',
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
                  '$who · ${scopeLabel(grant.scope)}',
                  style: context.textTheme.bodyLarge,
                ),
                const SizedBox(height: Grid.half),
                Text(agentLabel, style: muted),
                if (grant.dataSources.isNotEmpty ||
                    grant.questionKind != null) ...[
                  const SizedBox(height: Grid.half),
                  Wrap(
                    spacing: Grid.half,
                    runSpacing: Grid.half,
                    children: [
                      for (final source in grant.dataSources)
                        GuestBadge(label: dataSourceLabel(source)),
                      if (grant.questionKind != null)
                        GuestBadge(
                          label: questionKindLabel(grant.questionKind),
                        ),
                    ],
                  ),
                ],
                const SizedBox(height: Grid.half),
                Text(grantUsageLine(grant), style: muted),
              ],
            ),
          ),
          const SizedBox(width: Grid.xxs),
          OutlinedButton(
            key: const ValueKey('guest-grant-revoke'),
            onPressed: busy.value ? null : () => unawaited(revoke()),
            child: const Text('Revoke'),
          ),
        ],
      ),
    );
  }
}
