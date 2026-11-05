import 'package:flutter/foundation.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../agent_details/agent_summary.dart';
import 'agent_dm_delegation_client.dart';

// "/file" (BZ-FILES, 79 2026-11-05 D4): file names in the reader's own
// session's project folder, from the host's `agents/<id>/session/files` on
// the Buzz mount (the apps' own files list, the signer's own bound session).
// Names only: nothing here opens or reads a file.

final _uuid = RegExp(
  r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
  caseSensitive: false,
);
const _kinds = {'file', 'directory', 'symlink', 'other'};

@immutable
class AgentDmSessionFile {
  const AgentDmSessionFile({required this.path, required this.kind});

  /// Relative to the session's project folder.
  final String path;

  /// `file`, `directory`, `symlink` or `other`.
  final String kind;

  bool get isDirectory => kind == 'directory';

  @override
  bool operator ==(Object other) =>
      other is AgentDmSessionFile && other.path == path && other.kind == kind;

  @override
  int get hashCode => Object.hash(path, kind);
}

/// A page of names, or the host's own sentence for why there is none.
@immutable
class AgentDmSessionFilePage {
  const AgentDmSessionFilePage.ok(this.entries, this.nextCursor) : note = null;
  const AgentDmSessionFilePage.unavailable(String this.note)
    : entries = const [],
      nextCursor = null;

  final List<AgentDmSessionFile> entries;
  final String? nextCursor;

  /// Set when the folder can't be listed (missing, machine offline …).
  final String? note;
}

/// The host's `{ data }`.
AgentDmSessionFilePage? parseAgentDmSessionFiles(Object? body) {
  final data = body is Map ? body['data'] : null;
  if (data is! Map) return null;
  if (data['state'] == 'unavailable') {
    final note = data['note'];
    return AgentDmSessionFilePage.unavailable(
      note is String && note.isNotEmpty
          ? note
          : "This session's files can't be listed right now.",
    );
  }
  final entries = data['entries'];
  if (data['state'] != 'ok' || entries is! List) return null;
  final cursor = data['next_cursor'];
  return AgentDmSessionFilePage.ok([
    for (final raw in entries)
      if (raw is Map)
        if (raw['path'] case final String path when path.isNotEmpty)
          if (raw['kind'] case final String kind when _kinds.contains(kind))
            AgentDmSessionFile(path: path, kind: kind),
  ], cursor is String && cursor.isNotEmpty ? cursor : null);
}

/// `dir` (a folder) or `q` (a search), never both, and `cursor`; each at
/// most once, percent-encoded.
String agentDmSessionFilesPath(
  String agentId, {
  String? dir,
  String? query,
  String? cursor,
}) {
  final q = query?.trim() ?? '';
  final params = [
    if (q.isNotEmpty)
      'q=${Uri.encodeComponent(q)}'
    else if (dir != null && dir.isNotEmpty)
      'dir=${Uri.encodeComponent(dir)}',
    if (cursor != null && cursor.isNotEmpty)
      'cursor=${Uri.encodeComponent(cursor)}',
  ];
  return 'agents/$agentId/session/files'
      '${params.isEmpty ? '' : '?${params.join('&')}'}';
}

/// A failed read in plain words.
String agentDmSessionFilesErrorSentence(Object error) =>
    error is DelegationApiException && error.code == 'session_not_found'
    ? 'This conversation has no session, so there are no files to reference.'
    : error is DelegationApiException && error.code == 'agent_not_hosted'
    ? 'This agent has no host, so there is nothing to reference here.'
    : "Couldn't list the files right now. Try again.";

/// One page. Throws on a failed read; `ref.invalidate` reads again.
final agentDmSessionFilesProvider = FutureProvider.autoDispose
    .family<
      AgentDmSessionFilePage,
      ({String agentPubkey, String? dir, String query, String? cursor})
    >((ref, key) async {
      final client = ref.watch(delegationClientProvider);
      final summary = await ref.read(
        agentSummaryProvider(key.agentPubkey.toLowerCase()).future,
      );
      final agentId = summary?.agentId;
      if (client == null || agentId == null || !_uuid.hasMatch(agentId)) {
        throw const DelegationApiException(null, 'agent_not_hosted');
      }
      final page = parseAgentDmSessionFiles(
        await client.send(
          'GET',
          agentDmSessionFilesPath(
            agentId.toLowerCase(),
            dir: key.dir,
            query: key.query,
            cursor: key.cursor,
          ),
        ),
      );
      if (page == null) {
        throw const DelegationApiException(null, 'response_malformed');
      }
      return page;
    });
