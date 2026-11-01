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
/// owner sees where a worker-reported link goes before opening it. The host
/// shows in its ASCII form, as desktop's URL parser shows it: a Unicode
/// label becomes punycode ("xn--pple-43d.com"), so a look-alike host cannot
/// pass for a familiar one.
String delegationPreviewLinkLabel(String label, String url) {
  final host = delegationAsciiHost(Uri.tryParse(url)?.host ?? '');
  return host.isEmpty ? label : '$label ($host)';
}

/// [host] (as `Uri.host` gives it, percent-encoded past ASCII) in lowercase
/// ASCII, every non-ASCII label as `xn--` punycode (RFC 3492).
String delegationAsciiHost(String host) {
  String decoded;
  try {
    decoded = Uri.decodeComponent(host);
  } on ArgumentError {
    decoded = host;
  }
  return decoded
      .toLowerCase()
      .split('.')
      .map(
        (part) => part.runes.every((c) => c < 0x80)
            ? part
            : 'xn--${_punycode(part.runes.toList())}',
      )
      .join('.');
}

/// RFC 3492 §6.3 encoding of one label's code points.
String _punycode(List<int> input) {
  const base = 36, tMin = 1, tMax = 26, skew = 38, damp = 700;
  int adapt(int delta, int points, {required bool first}) {
    var d = first ? delta ~/ damp : delta ~/ 2;
    d += d ~/ points;
    var k = 0;
    while (d > ((base - tMin) * tMax) ~/ 2) {
      d ~/= base - tMin;
      k += base;
    }
    return k + ((base - tMin + 1) * d) ~/ (d + skew);
  }

  String digit(int d) => String.fromCharCode(d < 26 ? 0x61 + d : 0x16 + d);

  final out = StringBuffer();
  for (final c in input) {
    if (c < 0x80) out.writeCharCode(c);
  }
  final basic = out.length;
  if (basic > 0) out.write('-');
  var handled = basic;
  var n = 0x80, delta = 0, bias = 72;
  while (handled < input.length) {
    final m = input.where((c) => c >= n).reduce((a, b) => a < b ? a : b);
    delta += (m - n) * (handled + 1);
    n = m;
    for (final c in input) {
      if (c < n) delta++;
      if (c != n) continue;
      var q = delta;
      for (var k = base; ; k += base) {
        final t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);
        if (q < t) break;
        out.write(digit(t + (q - t) % (base - t)));
        q = (q - t) ~/ (base - t);
      }
      out.write(digit(q));
      bias = adapt(delta, handled + 1, first: handled == basic);
      delta = 0;
      handled++;
    }
    delta++;
    n++;
  }
  return out.toString();
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
