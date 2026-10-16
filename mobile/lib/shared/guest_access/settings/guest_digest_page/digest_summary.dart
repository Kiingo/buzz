part of '../guest_digest_page.dart';

class _DigestSummary extends StatelessWidget {
  const _DigestSummary({required this.digest});

  final GuestDigest digest;

  @override
  Widget build(BuildContext context) {
    final outcomes = digest.byOutcome.entries.toList()
      ..sort((a, b) => b.value.compareTo(a.value));
    final requesters = [...digest.byRequester]
      ..sort((a, b) => b.count.compareTo(a.count));
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: Grid.gutter,
            vertical: Grid.xxs,
          ),
          child: Row(
            children: [
              _Stat(label: 'Requests', value: digest.total),
              const SizedBox(width: Grid.xxs),
              _Stat(label: 'Flagged', value: digest.flaggedRequests),
              const SizedBox(width: Grid.xxs),
              _Stat(label: 'Waiting', value: digest.pendingApprovals),
              const SizedBox(width: Grid.xxs),
              _Stat(label: 'Suggestions', value: digest.openSuggestions),
            ],
          ),
        ),
        if (outcomes.isNotEmpty)
          AppListCard(
            label: 'Outcomes',
            verticalPadding: Grid.twelve,
            dividerIndent: Grid.xs,
            children: [
              for (final entry in outcomes)
                AppListRow(
                  title: outcomeLabel(entry.key),
                  value: '${entry.value}',
                  verticalPadding: Grid.twelve,
                ),
            ],
          ),
        if (requesters.isNotEmpty)
          AppListCard(
            label: 'Who asked',
            verticalPadding: Grid.twelve,
            dividerIndent: Grid.xs,
            children: [
              for (final row in requesters)
                AppListRow(
                  title: requesterLabel(
                    GuestRequester(
                      pubkey: row.pubkey,
                      displayName: row.displayName,
                    ),
                  ),
                  value: '${row.count}',
                  verticalPadding: Grid.twelve,
                ),
            ],
          ),
      ],
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat({required this.label, required this.value});

  final String label;
  final int value;

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: Container(
        padding: const EdgeInsets.symmetric(
          horizontal: Grid.xxs,
          vertical: Grid.xxs,
        ),
        decoration: BoxDecoration(
          color: context.colors.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(Radii.lg),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '$value',
              style: context.textTheme.titleLarge?.copyWith(
                fontWeight: FontWeight.w600,
                fontFeatures: const [FontFeature.tabularFigures()],
              ),
            ),
            Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: context.textTheme.labelSmall?.copyWith(
                color: context.colors.onSurfaceVariant,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
