part of '../guest_requests_page.dart';

class _RequestRow extends HookConsumerWidget {
  const _RequestRow({
    super.key,
    required this.entry,
    required this.agentLabel,
    required this.blocked,
  });

  final GuestAccessLogEntry entry;

  /// The agent asked, when the list spans every agent.
  final String? agentLabel;
  final bool blocked;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final busy = useState(false);
    final requester = entry.requester;
    final name = requesterLabel(requester);
    final tier = tierLabel(entry.tier);
    final classifier = classifierLine(entry.classifier);
    final muted = context.textTheme.bodySmall?.copyWith(
      color: context.colors.onSurfaceVariant,
    );
    final meta = [
      ?agentLabel,
      ?tier,
      if (formatShortDate(entry.at) case final at when at.isNotEmpty) at,
    ].join(' · ');

    Future<void> block() async {
      final confirmed = await confirmGuestOwnerAction(
        context,
        title: 'Block $name?',
        message:
            "$name won't get answers from any of your agents. You can "
            'unblock them in Blocked people.',
        confirmLabel: 'Block',
      );
      if (!confirmed || !context.mounted) return;
      busy.value = true;
      await runGuestOwnerAction(
        context,
        ref,
        (client) => client.block(pubkey: requester.pubkey),
        done: '$name is blocked.',
      );
      if (context.mounted) busy.value = false;
    }

    return Padding(
      padding: EdgeInsets.symmetric(
        horizontal: AppListInset.of(context),
        vertical: Grid.twelve,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Wrap(
                  spacing: Grid.half,
                  runSpacing: Grid.half,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    Text(name, style: context.textTheme.bodyLarge),
                    if (requester.isTest) const GuestBadge(label: 'Test'),
                    if (!requester.linked)
                      const GuestBadge(label: 'Not linked'),
                    GuestBadge(
                      label: outcomeLabel(entry.outcome),
                      tone: outcomeTone(entry.outcome),
                    ),
                  ],
                ),
              ),
              if (requester.pubkey.isNotEmpty)
                TextButton(
                  key: const ValueKey('guest-request-block'),
                  onPressed: busy.value || blocked
                      ? null
                      : () => unawaited(block()),
                  child: Text(blocked ? 'Blocked' : 'Block'),
                ),
            ],
          ),
          if (meta.isNotEmpty) Text(meta, style: muted),
          if (entry.questionText != null) ...[
            const SizedBox(height: Grid.half),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(
                horizontal: Grid.xxs,
                vertical: Grid.half,
              ),
              decoration: BoxDecoration(
                color: context.colors.onSurface.withValues(alpha: 0.05),
                borderRadius: BorderRadius.circular(Radii.md),
              ),
              child: Text(
                '“${entry.questionText}”',
                style: context.textTheme.bodySmall,
              ),
            ),
          ],
          if (entry.dataSources.isNotEmpty) ...[
            const SizedBox(height: Grid.half),
            Text(
              'Used: ${entry.dataSources.map(dataSourceLabel).join(', ')}',
              style: muted,
            ),
          ],
          for (final category in entry.classifier.categories)
            Text('• ${classifierReason(category)}', style: muted),
          if (classifier != null) Text(classifier, style: muted),
        ],
      ),
    );
  }
}
