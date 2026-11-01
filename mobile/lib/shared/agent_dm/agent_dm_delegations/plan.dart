part of '../agent_dm_delegations.dart';

// Plan (the orchestration journal, §16.6), group notes (§16.5) and the done
// card's results preview: the same rules as desktop's `delegations.ts`.
// Owner-only reads beside the board, read when the owner opens them.

/// The done card's results preview (IDelegationResultPreview), as the
/// worker reported it. A URL the host did not mark linkable shows as plain
/// text, never a link.
@immutable
class DelegationResultPreview {
  const DelegationResultPreview({
    this.filesChanged = const [],
    this.filesChangedCount,
    this.diffFiles,
    this.insertions,
    this.deletions,
    this.prUrl,
    this.prUrlLinkable = false,
    this.testReceiptUrl,
    this.testReceiptUrlLinkable = false,
  });

  final List<String> filesChanged;
  final int? filesChangedCount;
  final int? diffFiles;
  final int? insertions;
  final int? deletions;
  final String? prUrl;
  final bool prUrlLinkable;
  final String? testReceiptUrl;
  final bool testReceiptUrlLinkable;

  /// "12 files · +340 −20", or null.
  String? get diffText {
    final files =
        diffFiles ??
        filesChangedCount ??
        (filesChanged.isEmpty ? null : filesChanged.length);
    final parts = [
      if (files != null && files > 0) '$files ${files == 1 ? 'file' : 'files'}',
      if (insertions != null && deletions != null) '+$insertions −$deletions',
    ];
    return parts.isEmpty ? null : parts.join(' · ');
  }

  static final _https = RegExp(r'^https://\S+$', caseSensitive: false);

  /// The preview, or null when it carries nothing to show.
  static DelegationResultPreview? tryParse(Object? value) {
    final record = _map(value);
    if (record == null) return null;
    final rawFiles = record['filesChanged'];
    final files = rawFiles is List
        ? [for (final path in rawFiles) ?_text(path)]
        : const <String>[];
    final stat = _map(record['diffStat']);
    final hasStat =
        stat != null &&
        _number(stat['files']) != null &&
        _number(stat['insertions']) != null &&
        _number(stat['deletions']) != null;
    final count = _number(record['filesChangedCount']);
    final prUrl = _text(record['prUrl']);
    final testUrl = _text(record['testReceiptUrl']);
    final preview = DelegationResultPreview(
      filesChanged: files,
      filesChangedCount: count == null ? null : _count(count),
      diffFiles: hasStat ? _count(stat['files']) : null,
      insertions: hasStat ? _count(stat['insertions']) : null,
      deletions: hasStat ? _count(stat['deletions']) : null,
      prUrl: prUrl,
      prUrlLinkable:
          record['prUrlLinkable'] == true &&
          prUrl != null &&
          _https.hasMatch(prUrl),
      testReceiptUrl: testUrl,
      testReceiptUrlLinkable:
          record['testReceiptUrlLinkable'] == true &&
          testUrl != null &&
          _https.hasMatch(testUrl),
    );
    final empty =
        files.isEmpty &&
        (preview.filesChangedCount ?? 0) == 0 &&
        !hasStat &&
        prUrl == null &&
        testUrl == null;
    return empty ? null : preview;
  }
}

/// A linkable preview URL's label with its host, "PR (github.com)", so the
/// owner sees where a worker-reported link goes before opening it.
String delegationPreviewLinkLabel(String label, String url) {
  final host = Uri.tryParse(url)?.host.toLowerCase() ?? '';
  return host.isEmpty ? label : '$label ($host)';
}

enum DelegationJournalKind {
  decision('Decided'),
  waiting('Waiting on'),
  next('Next'),
  note('Note');

  const DelegationJournalKind(this.label);

  final String label;

  static DelegationJournalKind? tryParse(Object? value) => switch (value) {
    'decision' => decision,
    'waiting' => waiting,
    'next' => next,
    'note' => note,
    _ => null,
  };
}

/// One entry of the orchestrator's Plan.
@immutable
class DelegationJournalEntry {
  const DelegationJournalEntry({
    required this.id,
    required this.kind,
    required this.body,
  });

  final String id;
  final DelegationJournalKind kind;
  final String body;
}

/// One shared note of a parallel group.
@immutable
class DelegationGroupNote {
  const DelegationGroupNote({
    required this.id,
    required this.byOrchestrator,
    required this.delegationId,
    required this.body,
  });

  final String id;
  final bool byOrchestrator;

  /// The author's delegation, when a worker wrote it.
  final String? delegationId;
  final String body;
}

String delegationJournalPath(String agentId) =>
    'agents/${agentId.toLowerCase()}/delegations/journal?limit=50';

String delegationGroupNotesPath(String agentId, String group) =>
    'agents/${agentId.toLowerCase()}/delegations/groups/'
    '${_encodeRev(group)}/notes?limit=200';

/// IOrchestrationJournalPage, newest first; malformed entries dropped.
List<DelegationJournalEntry> parseDelegationJournal(Object? value) {
  final raw = _map(value)?['entries'];
  if (raw is! List) return const [];
  return [
    for (final item in raw)
      if (_map(item) case final record?)
        if ((
              _uuidOrNull(record['id']),
              DelegationJournalKind.tryParse(record['kind']),
              _text(record['body']),
            )
            case (final id?, final kind?, final body?))
          DelegationJournalEntry(id: id, kind: kind, body: body),
  ];
}

/// IDelegationGroupNotesPage, oldest first; malformed notes dropped.
List<DelegationGroupNote> parseDelegationGroupNotes(Object? value) {
  final raw = _map(value)?['notes'];
  if (raw is! List) return const [];
  return [
    for (final item in raw)
      if (_map(item) case final record?)
        if ((_uuidOrNull(record['id']), _text(record['body']))
            case (final id?, final body?)
            when record['authorRole'] == 'orchestrator' ||
                record['authorRole'] == 'worker')
          DelegationGroupNote(
            id: id,
            byOrchestrator: record['authorRole'] == 'orchestrator',
            delegationId: _uuidOrNull(record['delegationId']),
            body: body,
          ),
  ];
}

/// The parallel groups on the board, in the order their cards appear.
List<String> delegationBoardGroups(List<DelegationCard> cards) => [
  ...{for (final card in cards) ?card.parallelGroup},
];
