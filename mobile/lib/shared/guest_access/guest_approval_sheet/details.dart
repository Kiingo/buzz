part of '../guest_approval_sheet.dart';

enum _BadgeTone { danger, info, success, warning, neutral }

class _Badge extends StatelessWidget {
  const _Badge({required this.label, required this.tone, this.icon});

  final String label;
  final _BadgeTone tone;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final app = context.appColors;
    final color = switch (tone) {
      _BadgeTone.danger => colors.error,
      _BadgeTone.info => colors.primary,
      _BadgeTone.success => app.success,
      _BadgeTone.warning => app.warning,
      _BadgeTone.neutral => colors.onSurfaceVariant,
    };
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: Grid.xxs,
        vertical: Grid.quarter,
      ),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(Radii.sm),
        border: Border.all(color: color.withValues(alpha: 0.4)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[
            Icon(icon, size: 12, color: color),
            const SizedBox(width: Grid.half),
          ],
          Text(
            label,
            style: context.textTheme.labelSmall?.copyWith(
              color: color,
              fontWeight: FontWeight.w600,
            ),
          ),
        ],
      ),
    );
  }
}

/// Who is asking, in one line: name, a TEST badge for seeded test
/// identities, how the route classified them, link state, and how long ago
/// they linked and whether this is their first request.
class _RequesterLine extends StatelessWidget {
  const _RequesterLine({required this.requester});

  final GuestRequester requester;

  @override
  Widget build(BuildContext context) {
    final kind = requesterKindBadge(requester);
    final details = requesterDetails(requester);
    return Wrap(
      spacing: Grid.xxs,
      runSpacing: Grid.half,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        Text(
          requesterLabel(requester),
          style: context.textTheme.bodyMedium?.copyWith(
            fontWeight: FontWeight.w600,
          ),
        ),
        if (requester.isTest)
          const _Badge(
            label: 'TEST',
            tone: _BadgeTone.danger,
            icon: GuestAccessIcons.flask,
          ),
        if (kind != null) _Badge(label: kind, tone: _BadgeTone.info),
        requester.linked
            ? const _Badge(
                label: 'Linked account',
                tone: _BadgeTone.success,
                icon: BuzzIcons.link2,
              )
            : const _Badge(
                label: 'Not linked',
                tone: _BadgeTone.warning,
                icon: GuestAccessIcons.linkOff,
              ),
        if (details.isNotEmpty)
          Text(
            details.join(' · '),
            style: context.textTheme.bodySmall?.copyWith(
              color: context.colors.onSurfaceVariant,
            ),
          ),
      ],
    );
  }
}

class _DetailRow extends StatelessWidget {
  const _DetailRow({required this.label, required this.child});

  final String label;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: Grid.half),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 72,
            child: Text(
              label,
              style: context.textTheme.bodySmall?.copyWith(
                color: context.colors.onSurfaceVariant,
              ),
            ),
          ),
          Expanded(child: child),
        ],
      ),
    );
  }
}

class _SectionLabel extends StatelessWidget {
  const _SectionLabel(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: Grid.twelve, bottom: Grid.half),
      child: Text(
        text.toUpperCase(),
        style: context.textTheme.labelSmall?.copyWith(
          color: context.colors.onSurfaceVariant,
          letterSpacing: 0.6,
        ),
      ),
    );
  }
}

String? _formatWhen(BuildContext context, String? iso) {
  if (iso == null) return null;
  final at = DateTime.tryParse(iso)?.toLocal();
  if (at == null) return null;
  final localizations = MaterialLocalizations.of(context);
  return '${localizations.formatMediumDate(at)}, '
      '${localizations.formatTimeOfDay(TimeOfDay.fromDateTime(at))}';
}

/// Everything an owner reviews before releasing a guest reply: who asked and
/// where, what they asked, the exact draft, which data it used, and why it
/// was held, in plain language.
class _ApprovalDetails extends StatelessWidget {
  const _ApprovalDetails({required this.approval, this.showDraft = true});

  final GuestApproval approval;
  final bool showDraft;

  @override
  Widget build(BuildContext context) {
    final agent = approval.agentDisplayName ?? 'Your agent';
    final ownerOnly = approval.ownerOnlySources.toSet();
    final ownerData = approval.isOwnerDataRequest;
    final reasons = approval.reasonCodes.map(approvalReason).toList();
    // The owner-data reason already says the answer needs the owner's data.
    final flags = [
      for (final category in approval.classifier.categories)
        if (!(ownerData && category == 'needs_owner_data')) category,
    ];
    final scores =
        approval.classifier.topScores.entries
            .where((entry) => entry.value >= 0.4)
            .toList()
          ..sort((a, b) => b.value.compareTo(a.value));
    final expires = _formatWhen(context, approval.expiresAt);
    final channel = approval.channel;
    final muted = context.textTheme.bodySmall?.copyWith(
      color: context.colors.onSurfaceVariant,
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          padding: const EdgeInsets.all(Grid.twelve),
          decoration: BoxDecoration(
            color: context.colors.surfaceContainerHighest.withValues(
              alpha: 0.4,
            ),
            borderRadius: BorderRadius.circular(Radii.lg),
          ),
          child: Column(
            children: [
              _DetailRow(
                label: 'From',
                child: _RequesterLine(requester: approval.requester),
              ),
              _DetailRow(label: 'Asked', child: Text(agent)),
              _DetailRow(
                label: 'Where',
                child: Text(
                  channel.type == 'dm'
                      ? 'Direct message'
                      : '#${channel.name ?? 'a channel'}'
                            '${channel.audienceTotal != null ? ' · ${channel.audienceTotal} people can see the reply' : ''}',
                ),
              ),
              if (expires != null)
                _DetailRow(label: 'Expires', child: Text(expires)),
            ],
          ),
        ),
        if (approval.questionText case final question?) ...[
          const _SectionLabel('Their message'),
          Container(
            padding: const EdgeInsets.symmetric(
              horizontal: Grid.twelve,
              vertical: Grid.xxs,
            ),
            decoration: BoxDecoration(
              border: Border(
                left: BorderSide(
                  color: context.colors.outlineVariant,
                  width: 2,
                ),
              ),
            ),
            child: SelectableText(question),
          ),
        ],
        if (showDraft) ...[
          _SectionLabel(
            ownerData
                ? 'What they were told while you decide'
                : 'Reply that will be sent, exactly as written',
          ),
          Container(
            padding: const EdgeInsets.all(Grid.twelve),
            decoration: BoxDecoration(
              border: Border.all(color: context.colors.outlineVariant),
              borderRadius: BorderRadius.circular(Radii.lg),
            ),
            child: SelectableText(approval.draftText ?? ''),
          ),
        ],
        const _SectionLabel('Information used'),
        if (approval.dataSources.isEmpty)
          Text(
            ownerData
                ? 'Nothing private has been read yet.'
                : 'No private data was read.',
            style: muted,
          )
        else
          Wrap(
            spacing: Grid.half,
            runSpacing: Grid.half,
            children: [
              for (final source in approval.dataSources)
                ownerOnly.contains(source)
                    ? _Badge(
                        label:
                            '${dataSourceLabel(source)} · only you can see this',
                        tone: _BadgeTone.warning,
                        icon: BuzzIcons.lock,
                      )
                    : _Badge(
                        label: dataSourceLabel(source),
                        tone: _BadgeTone.neutral,
                      ),
            ],
          ),
        if (reasons.isNotEmpty || flags.isNotEmpty) ...[
          const _SectionLabel('Why this needs you'),
          for (final reason in [...reasons, ...flags.map(classifierReason)])
            Padding(
              padding: const EdgeInsets.only(bottom: Grid.quarter),
              child: Text('•  $reason'),
            ),
          if (scores.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: Grid.half),
              child: Text(
                'Safety check: ${scores.map((entry) => '${entry.key.replaceAll('_', ' ')} ${scorePercent(entry.value)}').join(' · ')}',
                style: muted,
              ),
            ),
        ],
      ],
    );
  }
}
