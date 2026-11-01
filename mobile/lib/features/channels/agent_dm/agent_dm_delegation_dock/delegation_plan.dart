part of '../agent_dm_delegation_dock.dart';

/// A collapsed row that reads its lines when opened, again whenever the
/// board moves ([revision]), and drops a read that lands after a newer one
/// or a close. Used for the Plan and each group's notes.
class _ReadOnOpenSection extends HookConsumerWidget {
  final String label;
  final String emptyText;
  final String revision;
  final Future<List<(String, String, String)>> Function() load;

  const _ReadOnOpenSection({
    super.key,
    required this.label,
    required this.emptyText,
    required this.revision,
    required this.load,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final open = useState(false);
    final lines = useState<List<(String, String, String)>?>(null);
    final failed = useState(false);
    final loadRef = useRef(load);
    loadRef.value = load;
    useEffect(() {
      if (!open.value) return null;
      var current = true;
      failed.value = false;
      loadRef.value().then(
        (items) {
          if (current) lines.value = items;
        },
        onError: (Object _) {
          if (current) failed.value = true;
        },
      );
      return () => current = false;
    }, [open.value, revision]);
    final colors = context.colors;
    final small = context.textTheme.labelSmall;
    final items = lines.value;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        Semantics(
          button: true,
          expanded: open.value,
          label: label,
          excludeSemantics: true,
          onTap: () => open.value = !open.value,
          child: InkWell(
            onTap: () => open.value = !open.value,
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: Grid.xxs),
              child: Row(
                children: [
                  Flexible(
                    child: Text(
                      label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: context.textTheme.bodyMedium?.copyWith(
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                  Icon(
                    open.value ? BuzzIcons.chevronDown : BuzzIcons.chevronRight,
                    size: 16,
                  ),
                ],
              ),
            ),
          ),
        ),
        if (open.value)
          if (failed.value)
            Text(
              "Couldn't load this. It tries again when the board changes.",
              style: small?.copyWith(color: colors.onSurfaceVariant),
            )
          else if (items == null)
            Text(
              'Loading…',
              style: small?.copyWith(color: colors.onSurfaceVariant),
            )
          else if (items.isEmpty)
            Text(
              emptyText,
              style: small?.copyWith(color: colors.onSurfaceVariant),
            )
          else
            for (final (id, lead, body) in items)
              Padding(
                key: ValueKey('delegation-line-$id'),
                padding: const EdgeInsets.only(bottom: Grid.quarter),
                child: Text.rich(
                  TextSpan(
                    children: [
                      TextSpan(
                        text: '$lead  ',
                        style: const TextStyle(fontWeight: FontWeight.w600),
                      ),
                      TextSpan(
                        text: body,
                        style: TextStyle(color: colors.onSurfaceVariant),
                      ),
                    ],
                  ),
                  style: small,
                ),
              ),
      ],
    );
  }
}

/// "Plan": the orchestrator's journal (§16.6), newest first.
Widget _planSection(DelegationBoardNotifier notifier, String revision) =>
    _ReadOnOpenSection(
      key: const ValueKey('agent-dm-delegation-plan'),
      label: 'Plan',
      emptyText: 'No plan written yet.',
      revision: revision,
      load: () async => [
        for (final entry in await notifier.journal())
          (entry.id, entry.kind.label, entry.body),
      ],
    );

/// One parallel group's shared notes (§16.5), oldest first.
Widget _groupNotesSection(
  DelegationBoardNotifier notifier,
  String group,
  String revision,
  Map<String, String> workerTitles,
) => _ReadOnOpenSection(
  key: ValueKey('agent-dm-delegation-notes-$group'),
  label: 'Notes · $group',
  emptyText: 'No notes in this group yet.',
  revision: revision,
  load: () async => [
    for (final note in await notifier.groupNotes(group))
      (
        note.id,
        note.byOrchestrator
            ? 'Orchestrator'
            : workerTitles[note.delegationId] ?? 'Worker',
        note.body,
      ),
  ],
);

/// The done card's results preview (§10.1): the diff summary, the first
/// files, the PR and the test receipt, as the worker reported them.
class _ResultPreview extends StatelessWidget {
  static const _filesShown = 5;

  final DelegationResultPreview preview;
  final Future<void> Function(String url) onOpen;

  const _ResultPreview({required this.preview, required this.onOpen});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final style = context.textTheme.labelSmall?.copyWith(
      color: colors.onSurfaceVariant,
    );
    final diff = preview.diffText;
    final shown = preview.filesChanged.take(_filesShown).toList();
    final total = preview.filesChangedCount ?? preview.filesChanged.length;
    final more = total - shown.length;
    Widget link(String label, String url, bool linkable) => linkable
        ? Semantics(
            button: true,
            label: 'Open the $label',
            excludeSemantics: true,
            onTap: () => onOpen(url),
            child: InkWell(
              onTap: () => onOpen(url),
              child: Text(label, style: style?.copyWith(color: colors.primary)),
            ),
          )
        : Flexible(
            child: Text(
              '$label: $url',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: style,
            ),
          );
    return Padding(
      key: const ValueKey('agent-dm-delegation-preview'),
      padding: const EdgeInsets.only(left: Grid.xxs, bottom: Grid.quarter),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (diff != null ||
              preview.prUrl != null ||
              preview.testReceiptUrl != null)
            Row(
              children: [
                if (diff != null) Text(diff, style: style),
                if (preview.prUrl case final url?) ...[
                  const SizedBox(width: Grid.xxs),
                  link('PR', url, preview.prUrlLinkable),
                ],
                if (preview.testReceiptUrl case final url?) ...[
                  const SizedBox(width: Grid.xxs),
                  link('Tests', url, preview.testReceiptUrlLinkable),
                ],
              ],
            ),
          if (shown.isNotEmpty)
            Text(
              '${shown.join(', ')}${more > 0 ? ' +$more more' : ''}',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: style?.copyWith(fontFamily: 'monospace'),
            ),
        ],
      ),
    );
  }
}
