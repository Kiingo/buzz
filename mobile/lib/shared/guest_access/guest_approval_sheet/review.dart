part of '../guest_approval_sheet.dart';

/// Owner review of one held guest reply: the details, an optional edit of
/// the exact text, a grant scope, and Approve / Edit then approve / Deny /
/// Deny and block person. No new model turn runs after approval; the text
/// shown (or the edited text) is what gets published.
///
/// Owner-data requests differ: the draft is only the hold message, approving
/// releases the chosen sources to one re-run of the guest turn, and "Edit
/// then approve" means writing the reply yourself.
class _ApprovalReview extends HookConsumerWidget {
  const _ApprovalReview({super.key, required this.approval});

  final GuestApproval approval;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final ownerData = approval.isOwnerDataRequest;
    final releasable = useMemoized(() => releasableSources(approval), [
      approval,
    ]);
    final sharedSources = useState<List<String>>(
      initialSharedSources(releasable.sources, releasable.mustChoose),
    );
    final editing = useState(false);
    final editController = useTextEditingController(
      text: ownerData ? '' : (approval.draftText ?? ''),
    );
    useListenable(editController);
    final grant = useState<GrantChoice>((
      scope: GrantScope.once,
      days: defaultGrantDays,
    ));
    final confirmBlock = useState(false);
    final pending = useState(false);
    final error = useState<String?>(null);
    // One key per approval so a retry after a network error is idempotent.
    final idempotencyKey = useMemoized(
      () => newDecisionIdempotencyKey(approval.approvalId),
      [approval.approvalId],
    );

    if (!approval.isPending) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          _ApprovalDetails(approval: approval),
          const SizedBox(height: Grid.twelve),
          Text(
            decidedStateText(approval),
            style: context.textTheme.bodyMedium?.copyWith(
              color: context.colors.onSurfaceVariant,
            ),
          ),
        ],
      );
    }

    final requester = requesterLabel(approval.requester);
    final agentName = approval.agentDisplayName ?? 'your agent';
    final trimmedEdit = editController.text.trim();
    // For owner-data requests the draft is the hold message, so the owner's
    // text is always a new reply and never falls back to a plain approve.
    final editChanged =
        ownerData || trimmedEdit != (approval.draftText ?? '').trim();
    final busy = pending.value;
    final approveDisabled = busy || (ownerData && sharedSources.value.isEmpty);
    final previewSentence = approvalPreviewSentence(
      approval,
      sharedSources: sharedSources.value,
      grant: grant.value,
      writingReply: editing.value,
    );

    Future<void> run(GuestDecisionInput input) async {
      final client = ref.read(guestAccessClientProvider);
      if (client == null) {
        error.value = describeGuestAccessError('guest_route_unavailable');
        return;
      }
      pending.value = true;
      error.value = null;
      try {
        final result = await submitGuestApprovalDecision(
          client: client,
          approval: approval,
          input: input,
          idempotencyKey: idempotencyKey,
          sendControl: ref.read(guestControlSenderProvider),
        );
        if (!context.mounted) return;
        final messenger = ScaffoldMessenger.maybeOf(context);
        Navigator.of(context).pop(true);
        messenger?.showSnackBar(
          SnackBar(
            content: Text(
              result.alreadyDecided
                  ? 'This request was already decided elsewhere.'
                  : 'Decision recorded.',
            ),
          ),
        );
      } on GuestAccessException catch (cause) {
        if (context.mounted) error.value = cause.message;
      } catch (_) {
        if (context.mounted) {
          error.value = describeGuestAccessError('request_failed');
        }
      } finally {
        if (context.mounted) pending.value = false;
      }
    }

    void approve() => unawaited(
      run(
        GuestDecisionInput(
          decision: ApprovalDecision.approve,
          grant: grantForChoice(grant.value),
          grantedSources: ownerData ? sharedSources.value : null,
        ),
      ),
    );

    void approveEdited() => unawaited(
      run(
        editChanged
            ? GuestDecisionInput(
                decision: ApprovalDecision.approveEdited,
                editedText: trimmedEdit,
                grant: grantForChoice(grant.value),
              )
            : GuestDecisionInput(
                decision: ApprovalDecision.approve,
                grant: grantForChoice(grant.value),
              ),
      ),
    );

    final muted = context.textTheme.bodySmall?.copyWith(
      color: context.colors.onSurfaceVariant,
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        _ApprovalDetails(approval: approval, showDraft: !editing.value),
        if (editing.value) ...[
          _SectionLabel(
            ownerData
                ? "Write the reply yourself. This exact text will be sent, and $agentName won't look anything up."
                : 'Edit the reply. This exact text will be sent.',
          ),
          TextField(
            key: const ValueKey('guest-approval-edit'),
            controller: editController,
            enabled: !busy,
            minLines: 4,
            maxLines: 10,
            decoration: const InputDecoration(border: OutlineInputBorder()),
          ),
        ],
        if (ownerData && !editing.value)
          _SourcesToSharePicker(
            agentName: agentName,
            enabled: !busy,
            mustChoose: releasable.mustChoose,
            sources: releasable.sources,
            selected: sharedSources.value,
            onChanged: (next) => sharedSources.value = next,
          ),
        _GrantScopePicker(
          enabled: !busy,
          requesterName: requester,
          requesterLinked: approval.requester.linked,
          value: grant.value,
          onChanged: (next) => grant.value = next,
        ),
        if (error.value != null)
          Padding(
            padding: const EdgeInsets.only(top: Grid.xxs),
            child: Text(
              error.value!,
              style: context.textTheme.bodySmall?.copyWith(
                color: context.colors.error,
              ),
            ),
          ),
        if (confirmBlock.value)
          Container(
            key: const ValueKey('guest-approval-block-confirm'),
            margin: const EdgeInsets.only(top: Grid.twelve),
            padding: const EdgeInsets.all(Grid.twelve),
            decoration: BoxDecoration(
              color: context.colors.error.withValues(alpha: 0.06),
              border: Border.all(
                color: context.colors.error.withValues(alpha: 0.4),
              ),
              borderRadius: BorderRadius.circular(Radii.lg),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  'Decline and block $requester? Your agents will stop answering them until you unblock them in agent settings on desktop.',
                ),
                const SizedBox(height: Grid.xxs),
                Wrap(
                  alignment: WrapAlignment.end,
                  spacing: Grid.xxs,
                  children: [
                    TextButton(
                      onPressed: busy ? null : () => confirmBlock.value = false,
                      child: const Text('Keep reviewing'),
                    ),
                    FilledButton(
                      style: FilledButton.styleFrom(
                        backgroundColor: context.colors.error,
                        foregroundColor: context.colors.onError,
                      ),
                      onPressed: busy
                          ? null
                          : () => unawaited(
                              run(
                                const GuestDecisionInput(
                                  decision: ApprovalDecision.denyAndBlock,
                                ),
                              ),
                            ),
                      child: const Text('Decline and block'),
                    ),
                  ],
                ),
              ],
            ),
          ),
        if (previewSentence != null)
          Container(
            key: const ValueKey('guest-approval-preview'),
            margin: const EdgeInsets.only(top: Grid.twelve),
            padding: const EdgeInsets.symmetric(
              horizontal: Grid.twelve,
              vertical: Grid.xxs,
            ),
            decoration: BoxDecoration(
              color: context.colors.surfaceContainerHighest.withValues(
                alpha: 0.4,
              ),
              border: Border.all(color: context.colors.outlineVariant),
              borderRadius: BorderRadius.circular(Radii.lg),
            ),
            child: Text(previewSentence),
          ),
        const SizedBox(height: Grid.twelve),
        if (editing.value) ...[
          FilledButton(
            key: const ValueKey('guest-approval-approve-edited'),
            onPressed: busy || trimmedEdit.isEmpty ? null : approveEdited,
            child: Text(
              busy
                  ? 'Sending…'
                  : ownerData
                  ? 'Send my reply'
                  : 'Approve edited reply',
            ),
          ),
          TextButton(
            onPressed: busy
                ? null
                : () {
                    editing.value = false;
                    editController.text = ownerData
                        ? ''
                        : (approval.draftText ?? '');
                  },
            child: const Text('Cancel edit'),
          ),
        ] else ...[
          FilledButton(
            key: const ValueKey('guest-approval-approve'),
            onPressed: approveDisabled ? null : approve,
            child: Text(
              busy
                  ? 'Sending…'
                  : ownerData
                  ? 'Share and let $agentName answer'
                  : 'Approve',
            ),
          ),
          const SizedBox(height: Grid.half),
          OutlinedButton(
            key: const ValueKey('guest-approval-edit-start'),
            onPressed: busy ? null : () => editing.value = true,
            child: Text(
              ownerData ? 'Write the reply myself' : 'Edit then approve',
            ),
          ),
        ],
        const SizedBox(height: Grid.half),
        Row(
          children: [
            Expanded(
              child: OutlinedButton(
                key: const ValueKey('guest-approval-deny'),
                onPressed: busy
                    ? null
                    : () => unawaited(
                        run(
                          const GuestDecisionInput(
                            decision: ApprovalDecision.deny,
                          ),
                        ),
                      ),
                child: const Text('Deny'),
              ),
            ),
            const SizedBox(width: Grid.xxs),
            Expanded(
              child: TextButton(
                key: const ValueKey('guest-approval-deny-block'),
                onPressed: busy || confirmBlock.value
                    ? null
                    : () => confirmBlock.value = true,
                child: const Text('Deny and block person'),
              ),
            ),
          ],
        ),
        if (approval.approvalUrl case final url?)
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton.icon(
              onPressed: () {
                final uri = Uri.tryParse(url);
                if (uri != null && uri.scheme == 'https') {
                  unawaited(
                    launchUrl(uri, mode: LaunchMode.externalApplication),
                  );
                }
              },
              icon: const Icon(BuzzIcons.externalLink, size: 14),
              label: Text('Open in browser', style: muted),
            ),
          ),
      ],
    );
  }
}
