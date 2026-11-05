import 'package:flutter/foundation.dart';

import 'agent_dm_delegation_client.dart';

// `/export` from the reader's own DM (BUZZPARITY E4, 79 2026-11-05 item 10):
// the session's whole conversation as one Markdown file, in the apps' format
// (Kiingo `harness-session-export.ts`), from the host's Buzz activity pages,
// newest first. Any failed page means no file, never a partial one: a page over
// the client's 2 MiB answer cap, a bad page or a repeated cursor. Every word is
// the session's: it goes to the person's file and nowhere else.

@immutable
class AgentDmSessionExport {
  const AgentDmSessionExport({
    required this.markdown,
    required this.turns,
    required this.fileName,
  });

  final String markdown;
  final int turns;
  final String fileName;
}

Map<Object?, Object?>? _map(Object? value) =>
    value is Map<Object?, Object?> ? value : null;

String? _text(Object? value) =>
    value is String && value.isNotEmpty ? value : null;

String _stamp(DateTime at) {
  final iso = at.toUtc().toIso8601String();
  return '${iso.substring(0, 16).replaceFirst('T', ' ')} UTC';
}

String _oneLine(String text) => text.split(RegExp(r'[\r\n]+')).join(' ');

String? _stepLine(Map<Object?, Object?> item) {
  final type = item['type'];
  final line = item['line'] is String ? item['line'] as String : '';
  if (type == 'reasoning') return null;
  if (type == 'note') {
    final text = (_text(item['text']) ?? line).trim();
    return text.isEmpty ? null : '- Note: ${_oneLine(text)}';
  }
  final name = _text(item['action']) ?? _text(item['name']);
  final oneLine = _oneLine(line);
  if (name != null && name != oneLine) {
    return oneLine.isEmpty ? '- Tool: $name' : '- Tool: $name · $oneLine';
  }
  return '- Tool: ${oneLine.isEmpty ? 'unnamed' : oneLine}';
}

List<String> _entryLines(Map<Object?, Object?> entry, String agent) {
  final role = entry['role'];
  final who = role == 'you'
      ? 'You'
      : role == 'agent'
      ? agent
      : 'Kiingo';
  final at = DateTime.tryParse(_text(entry['at']) ?? '');
  final images = entry['images'] is List ? (entry['images'] as List).length : 0;
  return [
    '',
    '## $who${at == null ? '' : ' · ${_stamp(at)}'}',
    '',
    entry['text'] as String,
    if (images > 0) ...[
      '',
      images == 1 ? '(1 image not included)' : '($images images not included)',
    ],
    if (entry['truncated'] == true) ...[
      '',
      '(Kiingo cut this message at 32 KB.)',
    ],
  ];
}

Map<Object?, Object?>? _entry(Object? value) {
  final entry = _map(value);
  return entry != null && entry['text'] is String ? entry : null;
}

/// The file: a heading per prompt and reply, a line per tool call and note.
@visibleForTesting
String agentDmSessionExportMarkdown({
  required List<Map<Object?, Object?>> turns,
  required String? harness,
  required DateTime now,
}) {
  final agent = switch (harness) {
    'claude_code' => 'Claude Code',
    'codex' => 'Codex',
    _ => 'Session',
  };
  final count = turns.length;
  final out = <String>[
    '# Session',
    '',
    'Exported from Buzz ${_stamp(now)}. $count ${count == 1 ? 'turn' : 'turns'}.',
  ];
  for (final turn in turns) {
    if (_entry(turn['prompt']) case final prompt?) {
      out.addAll(_entryLines(prompt, agent));
    }
    final steps = <String>[
      if (turn['items'] case final List items)
        for (final raw in items)
          if (_map(raw) case final item?) ?_stepLine(item),
    ];
    final omitted = turn['omitted'] is num
        ? (turn['omitted'] as num).floor()
        : 0;
    if (omitted > 0 || steps.isNotEmpty) {
      out.add('');
      if (omitted > 0) out.add('- ($omitted earlier steps not included)');
      out.addAll(steps);
    }
    if (_entry(turn['reply']) case final reply?) {
      out.addAll(_entryLines(reply, agent));
    }
  }
  out.add('');
  return out.join('\n');
}

const _incomplete = DelegationApiException(null, 'session_export_incomplete');

/// Read every page and build the file. Throws for a bad page or a repeated
/// cursor, and with the host's own refusal otherwise.
Future<AgentDmSessionExport> readAgentDmSessionExport(
  DelegationClient client,
  String agentId, {
  DateTime? now,
}) async {
  final pages = <List<Map<Object?, Object?>>>[];
  final cursors = <String>{};
  String? harness;
  String? before;
  while (true) {
    final query = before == null
        ? ''
        : '?before=${Uri.encodeQueryComponent(before)}';
    final data = _map(
      _map(
        await client.send('GET', 'agents/$agentId/session/activity$query'),
      )?['data'],
    );
    final page = _map(data?['page']);
    final turns = data?['turns'];
    if (data == null || page == null || turns is! List) throw _incomplete;
    // The host's exact false: it holds no copy of this session's transcript.
    if (data['transcriptAvailable'] == false) {
      throw const DelegationApiException(null, 'session_export_no_transcript');
    }
    final parsed = <Map<Object?, Object?>>[];
    for (final raw in turns) {
      final turn = _map(raw);
      if (turn == null || _text(turn['id']) == null) throw _incomplete;
      parsed.add(turn);
    }
    harness ??= _text(data['harness']);
    pages.add(parsed);
    if (page['hasMore'] != true) break;
    final next = _text(page['olderCursor']);
    if (next == null || !cursors.add(next)) throw _incomplete;
    before = next;
  }
  // Pages come newest first, each oldest first inside; one turn once.
  final seen = <String>{};
  final turns = [
    for (final page in pages.reversed)
      for (final turn in page)
        if (seen.add(turn['id'] as String)) turn,
  ];
  final at = now ?? DateTime.now();
  return AgentDmSessionExport(
    markdown: agentDmSessionExportMarkdown(
      turns: turns,
      harness: harness,
      now: at,
    ),
    turns: turns.length,
    fileName: 'session-${at.toUtc().toIso8601String().substring(0, 10)}.md',
  );
}
