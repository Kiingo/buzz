import 'package:flutter/foundation.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:uuid/uuid.dart';

import '../agent_commands/agent_commands.dart';
import '../agent_details/agent_summary.dart';
import 'agent_dm_delegation_client.dart';

// The reader's own session with a hosted agent, read from their 1:1 DM: its
// screens (/agents, /mcp, /permissions, /config, /hooks, /memory), the files
// it changed (/diff), their own queued messages, and Interrupt. From the
// host's `agents/<id>/session/...` routes on the Buzz mount, which pick the
// session themselves: the signer's own conversation's session, or 404.
//
// Everything here reads, except Withdraw and Edit (the reader's own queued
// message) and Interrupt (Esc; the session keeps going). Nothing writes a setting,
// types into a pane or runs a passkey command; the host strips every write
// action from a screen. Every word shown is the session's or a tool's:
// untrusted, plain text.

final _uuid = RegExp(
  r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
  caseSensitive: false,
);
final _builtinName = RegExp(r'^[a-z][a-z0-9-]{0,31}$');

/// The screens the host serves (`HARNESS_NATIVE_SCREENS`).
const agentDmSessionScreens = {
  'config',
  'permissions',
  'mcp',
  'agents',
  'hooks',
  'memory',
  'resume',
  'login',
  'approvals',
};

/// A read-only view of the session: a screen, the files changed, or the
/// reader's own queued messages.
@immutable
class AgentDmSessionView {
  const AgentDmSessionView.screen(String this.screen) : kind = 'screen';
  const AgentDmSessionView.files() : kind = 'files', screen = null;
  const AgentDmSessionView.queued() : kind = 'queued', screen = null;

  /// `screen`, `files` or `queued`.
  final String kind;
  final String? screen;

  @override
  bool operator ==(Object other) =>
      other is AgentDmSessionView &&
      other.kind == kind &&
      other.screen == screen;

  @override
  int get hashCode => Object.hash(kind, screen);
}

// ---- Wire shapes ----

@immutable
class AgentDmScreenRow {
  const AgentDmScreenRow({
    required this.label,
    this.value,
    this.detail,
    this.body,
    this.mono = false,
  });

  final String label;
  final String? value;
  final String? detail;
  final String? body;
  final bool mono;
}

@immutable
class AgentDmScreenSection {
  const AgentDmScreenSection({
    required this.id,
    required this.title,
    required this.unavailable,
    required this.rows,
    this.note,
    this.empty,
  });

  final String id;
  final String title;

  /// This source couldn't be read: never shown as empty.
  final bool unavailable;
  final String? note;
  final String? empty;
  final List<AgentDmScreenRow> rows;
}

@immutable
class AgentDmFileChange {
  const AgentDmFileChange({
    required this.id,
    required this.path,
    required this.kind,
    required this.failed,
    required this.added,
    required this.removed,
    required this.lines,
    this.movedTo,
  });

  final String id;
  final String path;
  final String kind;
  final String? movedTo;
  final bool failed;
  final int added;
  final int removed;

  /// Each line with its sign: ' ', '+' or '-'.
  final List<({String sign, String text})> lines;
}

@immutable
class AgentDmQueuedMessage {
  const AgentDmQueuedMessage({
    required this.messageId,
    required this.body,
    required this.idle,
  });

  final String messageId;
  final String body;

  /// Held for the session's next idle moment rather than its next turn.
  final bool idle;
}

/// What one view read: exactly one of the three is set.
@immutable
class AgentDmSessionViewRead {
  const AgentDmSessionViewRead.screen({
    required String this.title,
    required String this.description,
    required List<AgentDmScreenSection> this.sections,
  }) : changes = null,
       queued = null;
  const AgentDmSessionViewRead.files(List<AgentDmFileChange> this.changes)
    : title = null,
      description = null,
      sections = null,
      queued = null;
  const AgentDmSessionViewRead.queued(List<AgentDmQueuedMessage> this.queued)
    : title = null,
      description = null,
      sections = null,
      changes = null;

  final String? title;
  final String? description;
  final List<AgentDmScreenSection>? sections;
  final List<AgentDmFileChange>? changes;
  final List<AgentDmQueuedMessage>? queued;
}

/// A "/" row this client opens as a view.
@immutable
class AgentDmSessionBuiltin {
  const AgentDmSessionBuiltin({
    required this.name,
    required this.description,
    required this.view,
  });

  final String name;
  final String description;
  final AgentDmSessionView view;
}

/// A "/" row sent as typed (/review, /init): the host starts the chat's own
/// server-fixed turn for it in the reader's own DM (BZ-REVIEW, 79
/// 2026-11-05 D2).
@immutable
class AgentDmSessionPrompt {
  const AgentDmSessionPrompt({required this.name, required this.description});

  final String name;
  final String description;
}

@immutable
class AgentDmSessionBuiltins {
  const AgentDmSessionBuiltins({
    required this.inPane,
    required this.rows,
    this.prompts = const [],
  });

  /// The session runs in a pane (`tmux`), so Interrupt applies.
  final bool inPane;
  final List<AgentDmSessionBuiltin> rows;
  final List<AgentDmSessionPrompt> prompts;
}

String? _text(Object? value) =>
    value is String && value.isNotEmpty ? value : null;

int _count(Object? value) =>
    value is num && value.isFinite && value >= 0 ? value.floor() : 0;

Map<Object?, Object?>? _map(Object? value) =>
    value is Map<Object?, Object?> ? value : null;

/// A screen, read only: rows keep their words and nothing they could do.
AgentDmSessionViewRead? parseAgentDmSessionScreen(Object? body) {
  final value = _map(_map(body)?['data']);
  final rawSections = value?['sections'];
  if (value == null || rawSections is! List) return null;
  final sections = <AgentDmScreenSection>[];
  for (final raw in rawSections) {
    final section = _map(raw);
    final rawRows = section?['rows'];
    if (section == null || rawRows is! List) continue;
    final rows = <AgentDmScreenRow>[];
    for (final rawRow in rawRows) {
      final row = _map(rawRow);
      final label = _text(row?['label']);
      if (row == null || label == null) continue;
      rows.add(
        AgentDmScreenRow(
          label: label,
          value: _text(row['value']),
          detail: _text(row['detail']),
          body: _text(row['body']),
          mono: row['mono'] == true,
        ),
      );
    }
    sections.add(
      AgentDmScreenSection(
        id: _text(section['id']) ?? '${sections.length}',
        title: _text(section['title']) ?? '',
        unavailable: section['state'] == 'unavailable',
        note: _text(section['note']),
        empty: _text(section['empty']),
        rows: rows,
      ),
    );
  }
  return AgentDmSessionViewRead.screen(
    title: _text(value['title']) ?? '',
    description: _text(value['description']) ?? '',
    sections: sections,
  );
}

const _changeKinds = {'edit', 'create', 'delete', 'move'};
const _signs = {' ', '+', '-'};

List<AgentDmFileChange>? parseAgentDmFileChanges(Object? body) {
  final list = _map(body)?['data'];
  if (list is! List) return null;
  final changes = <AgentDmFileChange>[];
  for (final raw in list) {
    final change = _map(raw);
    final id = _text(change?['id']);
    final path = _text(change?['path']);
    final kind = change?['kind'];
    if (change == null || id == null || path == null) continue;
    if (kind is! String || !_changeKinds.contains(kind)) continue;
    final rawLines = change['lines'];
    final lines = <({String sign, String text})>[
      if (rawLines is List)
        for (final rawLine in rawLines)
          if (_map(rawLine) case final line?)
            if (line['sign'] case final String sign when _signs.contains(sign))
              if (line['text'] case final String text) (sign: sign, text: text),
    ];
    changes.add(
      AgentDmFileChange(
        id: id,
        path: path,
        kind: kind,
        movedTo: _text(change['moved_to']),
        failed: change['failed'] == true,
        added: _count(change['added']),
        removed: _count(change['removed']),
        lines: lines,
      ),
    );
  }
  return changes;
}

List<AgentDmQueuedMessage>? parseAgentDmQueuedMessages(Object? body) {
  final list = _map(body)?['data'];
  if (list is! List) return null;
  return [
    for (final raw in list)
      if (_map(raw) case final message?)
        if (_text(message['message_id']) case final id? when _uuid.hasMatch(id))
          AgentDmQueuedMessage(
            messageId: id.toLowerCase(),
            body: message['body'] is String ? message['body'] as String : '',
            idle: message['send_when'] == 'idle',
          ),
  ];
}

/// The "/" rows this client opens as views (a screen, or the files changed),
/// and the prompt rows it puts in the draft to send as typed (/review,
/// /init). Rows the panel already has, rows that go as text and rows this
/// session can't run are left to their own paths. The host lists no passkey
/// row to the Buzz app.
AgentDmSessionBuiltins? parseAgentDmSessionBuiltins(Object? body) {
  final value = _map(body);
  final session = _map(value?['session']);
  final commands = value?['commands'];
  if (value == null || session == null || commands is! List) return null;
  final rows = <AgentDmSessionBuiltin>[];
  final prompts = <AgentDmSessionPrompt>[];
  final seen = <String>{};
  for (final raw in commands) {
    final entry = _map(raw);
    final action = _map(entry?['action']);
    final name = _text(entry?['name']);
    if (entry?['kind'] != 'session' || action == null || name == null) {
      continue;
    }
    if (!_builtinName.hasMatch(name) || seen.contains(name)) continue;
    final description = _text(entry?['description']) ?? '';
    final shown = description.length > 300
        ? description.substring(0, 300)
        : description;
    if (action['kind'] == 'prompt') {
      seen.add(name);
      prompts.add(AgentDmSessionPrompt(name: name, description: shown));
      continue;
    }
    final screen = action['screen'];
    final AgentDmSessionView? view =
        action['kind'] == 'screen' &&
            screen is String &&
            agentDmSessionScreens.contains(screen)
        ? AgentDmSessionView.screen(screen)
        : action['kind'] == 'panel' && action['panel'] == 'diff'
        ? const AgentDmSessionView.files()
        : null;
    if (view == null) continue;
    seen.add(name);
    rows.add(AgentDmSessionBuiltin(name: name, description: shown, view: view));
  }
  return AgentDmSessionBuiltins(
    inPane: session['lane'] == 'tmux',
    rows: rows,
    prompts: prompts,
  );
}

/// The view row "/" picked as [name], or null.
AgentDmSessionView? agentDmSessionViewFor(
  AgentDmSessionBuiltins? builtins,
  String name,
) => builtins?.rows.where((row) => row.name == name).firstOrNull?.view;

final _typedViewCommand = RegExp(r'^/([a-z][a-z0-9-]{0,31})$');

/// Whether [message] is shaped like a typed view row, exactly `/name`, before
/// any read.
bool isAgentDmSessionViewShaped(String message) =>
    _typedViewCommand.hasMatch(message.trim());

/// The view row a whole typed message names, exactly `/name` (the desktop's
/// `sessionBuiltinForText`), or null: then it is an ordinary message.
AgentDmSessionView? agentDmSessionViewForText(
  AgentDmSessionBuiltins? builtins,
  String message,
) {
  final name = _typedViewCommand.firstMatch(message.trim())?.group(1);
  return name == null ? null : agentDmSessionViewFor(builtins, name);
}

/// [commands] with the session's view and prompt rows after its session
/// commands; a name already listed keeps its own row. A prompt row is put in
/// the draft as `/name ` and sent as typed.
List<AgentCommand> withAgentDmSessionViewCommands(
  List<AgentCommand> commands,
  AgentDmSessionBuiltins? builtins,
) {
  if (builtins == null || (builtins.rows.isEmpty && builtins.prompts.isEmpty)) {
    return commands;
  }
  final names = {for (final command in commands) command.name};
  final added = [
    for (final row in builtins.rows)
      if (!names.contains(row.name))
        AgentCommand.session(name: row.name, description: row.description),
    for (final row in builtins.prompts)
      if (!names.contains(row.name))
        AgentCommand.session(name: row.name, description: row.description),
  ];
  return [
    for (final command in commands)
      if (command.kind == AgentCommandKind.session) command,
    ...added,
    for (final command in commands)
      if (command.kind != AgentCommandKind.session) command,
  ];
}

// ---- Paths (the Buzz mount) ----

String agentDmSessionBuiltinsPath(String agentId) => 'agents/$agentId/commands';

String agentDmSessionViewPath(String agentId, AgentDmSessionView view) =>
    switch (view.kind) {
      'screen' => 'agents/$agentId/session/screens/${view.screen}',
      'files' => 'agents/$agentId/session/file-changes',
      _ => 'agents/$agentId/session/queued',
    };

String agentDmWithdrawPath(String agentId, String messageId) =>
    'agents/$agentId/session/queued/$messageId/withdraw';

String agentDmEditPath(String agentId, String messageId) =>
    'agents/$agentId/session/queued/$messageId/edit';

String agentDmInterruptPath(String agentId) =>
    'agents/$agentId/session/interrupt';

const _errorSentences = {
  'session_not_found': 'This conversation has no session to show right now.',
  'session_taken_over':
      'This session is taken over at its machine, so Interrupt is there.',
  'harness_session_message_not_found': "That message isn't waiting any more.",
  'harness_session_message_not_editable':
      "That message isn't waiting any more.",
  'harness_session_message_invalid': "A message can't be empty.",
};

/// A refusal in plain words.
String agentDmSessionViewErrorSentence(Object error) =>
    (error is DelegationApiException ? _errorSentences[error.code] : null) ??
    "Couldn't reach the session. Try again.";

// ---- The host ----

Future<String?> _hostedAgentId(Ref ref, String agentPubkey) async {
  final summary = await ref.read(
    agentSummaryProvider(agentPubkey.toLowerCase()).future,
  );
  final id = summary?.agentId;
  return id != null && _uuid.hasMatch(id) ? id.toLowerCase() : null;
}

/// The session's "/" view rows and lane for this agent's lowercase key; null
/// for an agent with no host and after any failure (no views, no Interrupt).
final agentDmSessionBuiltinsProvider = FutureProvider.autoDispose
    .family<AgentDmSessionBuiltins?, String>((ref, agentPubkey) async {
      final client = ref.watch(delegationClientProvider);
      if (client == null) return null;
      try {
        final agentId = await _hostedAgentId(ref, agentPubkey);
        if (agentId == null) return null;
        return parseAgentDmSessionBuiltins(
          await client.send('GET', agentDmSessionBuiltinsPath(agentId)),
        );
      } catch (error) {
        debugPrint('[AgentDmSessionViews] read failed: ${error.runtimeType}');
        return null;
      }
    });

/// One view's read. Throws on a failed read; `ref.invalidate` reads again.
final agentDmSessionViewProvider = FutureProvider.autoDispose
    .family<
      AgentDmSessionViewRead,
      ({String agentPubkey, AgentDmSessionView view})
    >((ref, key) async {
      final client = ref.watch(delegationClientProvider);
      final agentId = await _hostedAgentId(ref, key.agentPubkey);
      if (client == null || agentId == null) {
        throw const DelegationApiException(null, 'agent_not_hosted');
      }
      final body = await client.send(
        'GET',
        agentDmSessionViewPath(agentId, key.view),
      );
      final read = switch (key.view.kind) {
        'screen' => parseAgentDmSessionScreen(body),
        'files' => switch (parseAgentDmFileChanges(body)) {
          final changes? => AgentDmSessionViewRead.files(changes),
          null => null,
        },
        _ => switch (parseAgentDmQueuedMessages(body)) {
          final queued? => AgentDmSessionViewRead.queued(queued),
          null => null,
        },
      };
      if (read == null) {
        throw const DelegationApiException(null, 'response_malformed');
      }
      return read;
    });

final agentDmSessionViewActionsProvider = Provider<AgentDmSessionViewActions>(
  AgentDmSessionViewActions.new,
);

/// What a view does: withdraw or edit the reader's own queued message, and
/// interrupt the session's running step.
class AgentDmSessionViewActions {
  const AgentDmSessionViewActions(this._ref);

  final Ref _ref;

  Future<void> withdraw(String agentPubkey, String messageId) async {
    final client = _ref.read(delegationClientProvider);
    final agentId = await _hostedAgentId(_ref, agentPubkey);
    if (client == null || agentId == null || !_uuid.hasMatch(messageId)) {
      throw const DelegationApiException(
        null,
        'harness_session_message_not_found',
      );
    }
    try {
      await client.send(
        'POST',
        agentDmWithdrawPath(agentId, messageId.toLowerCase()),
        const <String, Object?>{},
      );
    } finally {
      _ref.invalidate(
        agentDmSessionViewProvider((
          agentPubkey: agentPubkey.toLowerCase(),
          view: const AgentDmSessionView.queued(),
        )),
      );
    }
  }

  /// Replace the reader's own queued message with [body] (BZ-QEDIT, 79
  /// 2026-11-05 D3), as an edit in the apps. One key per Save. Throws when
  /// it was taken meanwhile; the list reads again either way.
  Future<void> edit(String agentPubkey, String messageId, String body) async {
    final client = _ref.read(delegationClientProvider);
    final agentId = await _hostedAgentId(_ref, agentPubkey);
    if (client == null || agentId == null || !_uuid.hasMatch(messageId)) {
      throw const DelegationApiException(
        null,
        'harness_session_message_not_found',
      );
    }
    try {
      await client.send(
        'POST',
        agentDmEditPath(agentId, messageId.toLowerCase()),
        {'body': body, 'idempotency_key': const Uuid().v4()},
      );
    } finally {
      _ref.invalidate(
        agentDmSessionViewProvider((
          agentPubkey: agentPubkey.toLowerCase(),
          view: const AgentDmSessionView.queued(),
        )),
      );
    }
  }

  /// Esc in the session's pane: the running step stops, the session stays.
  Future<void> interrupt(String agentPubkey) async {
    final client = _ref.read(delegationClientProvider);
    final agentId = await _hostedAgentId(_ref, agentPubkey);
    if (client == null || agentId == null) {
      throw const DelegationApiException(null, 'agent_not_hosted');
    }
    await client.send('POST', agentDmInterruptPath(agentId), {
      'idempotency_key': const Uuid().v4(),
    });
  }
}
