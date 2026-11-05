import 'package:flutter/foundation.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../agent_details/agent_summary.dart';
import 'agent_dm_delegation_client.dart';
import 'agent_dm_markers.dart';

/// How a reply was made, under the hosted agent's reply in the reader's own
/// 1:1 DM: a quiet line ("Used 6 tools · 41 s", else "Steps") that opens the
/// turn's steps. The same line and read as the agent's chat in the other
/// apps, and as desktop's `turnSteps.ts`.
///
/// A Buzz reply names its Run (`kiingo-mission`), or, mirrored, its chat
/// entry (`buzz-mirror` source id). The reader's own chat page
/// (`GET agents/<id>/chat?contract=2`) ties that to the reply's entry and
/// turn; `GET agents/<id>/chat/turns/<turn>/activity` reads the steps. The
/// host answers only the reader's own conversation and Runs. A reply the
/// newest page doesn't hold shows no line. Read only.

/// The page read: the newest entries, where the replies' turns are named.
const agentDmTurnPageLimit = 50;

/// The line when the page has no counts for the reply.
const agentDmStepsLineUnknown = 'Steps';

const agentDmStepsReadFailed = "Couldn't load the steps. Try again.";

final _uuid = RegExp(
  r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
);

String? _text(Object? value) =>
    value is String && value.isNotEmpty ? value : null;

String? _id(Object? value) {
  final text = _text(value)?.toLowerCase();
  return text != null && _uuid.hasMatch(text) ? text : null;
}

int _count(Object? value) =>
    value is num && value.isFinite && value > 0 ? value.floor() : 0;

int? _ms(Object? value) =>
    value is num && value.isFinite ? (value < 0 ? 0 : value.round()) : null;

Map<Object?, Object?>? _map(Object? value) =>
    value is Map<Object?, Object?> ? value : null;

String _oneLine(String text, int max) {
  final flat = text.replaceAll(RegExp(r'\s+'), ' ').trim();
  return flat.length > max ? '${flat.substring(0, max - 1)}…' : flat;
}

/// What a Buzz reply says about where it came from.
@immutable
class AgentDmReplyKey {
  const AgentDmReplyKey({this.runId, this.entryId, required this.atMs});

  /// The Run behind the reply (`kiingo-mission`).
  final String? runId;

  /// The chat entry a mirrored reply copies (`buzz-mirror` source id).
  final String? entryId;

  /// The reply's own time, epoch ms.
  final int atMs;

  @override
  bool operator ==(Object other) =>
      other is AgentDmReplyKey &&
      other.runId == runId &&
      other.entryId == entryId &&
      other.atMs == atMs;

  @override
  int get hashCode => Object.hash(runId, entryId, atMs);
}

/// The reply's Run or mirrored entry, or null when it names neither.
AgentDmReplyKey? readAgentDmReplyKey(
  List<List<String>> tags,
  int createdAtSeconds,
) {
  final mirror = readAgentDmMirror(tags);
  final entryId = mirror?.role == AgentDmMirrorRole.agent
      ? _id(mirror!.sourceId.split('#').first)
      : null;
  String? runId;
  if (mirror == null) {
    final missions = [
      for (final tag in tags)
        if (tag.length > 1 && tag[0] == 'kiingo-mission') tag[1],
    ];
    runId = missions.length == 1 ? _id(missions.single) : null;
  }
  if (entryId == null && runId == null) return null;
  return AgentDmReplyKey(
    runId: runId,
    entryId: entryId,
    atMs: createdAtSeconds * 1000,
  );
}

/// "41 s", "3 min 5 s", "1 h 2 min": the other apps' words.
String agentDmStepsDuration(int durationMs) {
  final seconds = durationMs < 0 ? 0 : (durationMs / 1000).round();
  if (seconds < 60) return '$seconds s';
  final minutes = seconds ~/ 60;
  if (minutes < 60) {
    return seconds % 60 == 0
        ? '$minutes min'
        : '$minutes min ${seconds % 60} s';
  }
  return minutes % 60 == 0
      ? '${minutes ~/ 60} h'
      : '${minutes ~/ 60} h ${minutes % 60} min';
}

/// The activity summary's line: the server's label, else built the same way.
String? agentDmActivityLine(Object? summary) {
  final value = _map(summary);
  if (value == null) return null;
  final label = _text(value['label']);
  if (label != null) return _oneLine(label, 120);
  final tools = _count(value['tools']);
  if (tools + _count(value['reasoning']) == 0) return null;
  final used = tools == 1 ? 'Used 1 tool' : 'Used $tools tools';
  final duration = _ms(value['durationMs']);
  return duration == null ? used : '$used · ${agentDmStepsDuration(duration)}';
}

/// The memory label, then the tools and time; "Steps" without either.
String agentDmReplyLine(Object? activity, Object? memory) {
  final parts = <String>[];
  final memoryLabel = _text(_map(memory)?['label']);
  if (memoryLabel != null) parts.add(_oneLine(memoryLabel, 160));
  final tools = agentDmActivityLine(activity);
  if (tools != null) parts.add(tools);
  return parts.isEmpty ? agentDmStepsLineUnknown : parts.join(' · ');
}

/// One agent reply on the chat page, as far as its line needs.
@immutable
class AgentDmChatReply {
  const AgentDmChatReply({
    required this.id,
    required this.runId,
    required this.atMs,
    required this.turnId,
    required this.line,
    required this.running,
  });

  final String id;
  final String? runId;
  final int atMs;

  /// The id `…/turns/<id>/activity` takes for this reply.
  final String turnId;
  final String line;
  final bool running;
}

/// The agent replies on a contract-2 chat page, in page order.
List<AgentDmChatReply> parseAgentDmChatReplies(Object? page) {
  final entries = _map(page)?['entries'];
  if (entries is! List) return const [];
  final replies = <AgentDmChatReply>[];
  for (final raw in entries) {
    final entry = _map(raw);
    final id = _id(entry?['id']);
    final at = DateTime.tryParse(_text(entry?['at']) ?? '');
    if (entry == null || id == null || entry['role'] != 'agent' || at == null) {
      continue;
    }
    final activity = _map(entry['activity']);
    final memory = _map(entry['memory']);
    // The same turn the other apps open: the counts' turn, else the turn the
    // reply settled or opened, else the reply itself (a Run's own).
    final turnId =
        _id(memory?['turnId']) ??
        _id(activity?['turnId']) ??
        _id(entry['turnId']) ??
        _id(entry['chainTurnId']) ??
        id;
    replies.add(
      AgentDmChatReply(
        id: id,
        runId: _id(entry['runId']),
        atMs: at.millisecondsSinceEpoch,
        turnId: turnId,
        line: agentDmReplyLine(activity, memory),
        running: activity?['state'] == 'running',
      ),
    );
  }
  return replies;
}

/// The page reply a Buzz reply is: the mirrored entry itself, else the Run's
/// reply nearest the Buzz reply's time. Null when the page holds neither.
AgentDmChatReply? findAgentDmReply(
  List<AgentDmChatReply> replies,
  AgentDmReplyKey key,
) {
  if (key.entryId != null) {
    for (final reply in replies) {
      if (reply.id == key.entryId) return reply;
    }
    return null;
  }
  AgentDmChatReply? best;
  for (final reply in replies) {
    if (reply.runId != key.runId) continue;
    if (best == null ||
        (reply.atMs - key.atMs).abs() < (best.atMs - key.atMs).abs()) {
      best = reply;
    }
  }
  return best;
}

enum AgentDmStepState { running, done, failed }

/// One step of a turn. Every text is untrusted, shown as plain text.
@immutable
class AgentDmTurnStep {
  const AgentDmTurnStep({
    required this.id,
    required this.line,
    this.action,
    this.state = AgentDmStepState.done,
    this.text,
    this.args,
    this.result,
    this.linkUrl,
    this.linkTitle,
  });

  final String id;
  final String line;

  /// What the call ran ("Bash", "memory.recall"); tools only.
  final String? action;
  final AgentDmStepState state;
  final String? text;
  final String? args;
  final String? result;

  /// An https link only.
  final Uri? linkUrl;
  final String? linkTitle;

  bool get hasDetail => text != null || args != null || result != null;
}

@immutable
class AgentDmTurnSteps {
  const AgentDmTurnSteps({
    required this.turnId,
    required this.running,
    required this.items,
    this.durationMs,
    this.omitted = 0,
  });

  final String turnId;
  final bool running;
  final List<AgentDmTurnStep> items;
  final int? durationMs;

  /// Older steps the read left out.
  final int omitted;
}

AgentDmTurnStep? _step(Object? raw) {
  final value = _map(raw);
  final id = _text(value?['id']);
  if (value == null || id == null) return null;
  final type = value['type'];
  final tool = type != 'reasoning' && type != 'note';
  final text = _text(value['text']);
  // A reasoning or note step may carry its text without a line.
  final line = _text(value['line']) ?? text;
  if (line == null) return null;
  final action = tool ? (_text(value['action']) ?? _text(value['name'])) : null;
  final link = _map(value['link']);
  final url = Uri.tryParse(_text(link?['url']) ?? '');
  final https =
      url != null &&
      url.scheme == 'https' &&
      url.host.isNotEmpty &&
      url.userInfo.isEmpty;
  final title = _text(link?['title']);
  return AgentDmTurnStep(
    id: id,
    line: _oneLine(line, 140),
    action: action == null ? null : _oneLine(action, 160),
    state: switch (value['state']) {
      'running' => AgentDmStepState.running,
      'failed' => AgentDmStepState.failed,
      _ => AgentDmStepState.done,
    },
    text: text,
    args: _text(value['args']),
    result: _text(value['result']),
    linkUrl: https ? url : null,
    linkTitle: https && title != null ? _oneLine(title, 200) : null,
  );
}

/// `GET …/chat/turns/<id>/activity`, or null when it isn't one.
AgentDmTurnSteps? parseAgentDmTurnSteps(Object? body) {
  final value = _map(body);
  final turnId = _id(value?['turnId']);
  if (value == null || turnId == null) return null;
  final items = value['items'];
  return AgentDmTurnSteps(
    turnId: turnId,
    running: value['state'] == 'running',
    durationMs: _ms(value['durationMs']),
    omitted: _count(value['omitted']),
    items: [
      if (items is List)
        for (final item in items) ?_step(item),
    ],
  );
}

String agentDmTurnPagePath(String agentId) =>
    'agents/$agentId/chat?contract=2&limit=$agentDmTurnPageLimit';

String agentDmTurnStepsPath(String agentId, String turnId) =>
    'agents/$agentId/chat/turns/$turnId/activity';

// ---- The host ----

Future<String?> _hostedAgentId(Ref ref, String agentPubkey) async {
  final summary = await ref.read(
    agentSummaryProvider(agentPubkey.toLowerCase()).future,
  );
  return _id(summary?.agentId);
}

/// One page read and when it answered, epoch ms.
@immutable
class AgentDmTurnPage {
  const AgentDmTurnPage({required this.replies, required this.readAtMs});

  final List<AgentDmChatReply> replies;
  final int readAtMs;
}

/// The reader's own chat page for this agent's lowercase key, shared by
/// every reply row; null for an agent with no host and after any failure.
/// A row whose reply landed after the read invalidates it once.
final agentDmTurnPageProvider = FutureProvider.autoDispose
    .family<AgentDmTurnPage?, String>((ref, agentPubkey) async {
      final client = ref.watch(delegationClientProvider);
      if (client == null) return null;
      try {
        final agentId = await _hostedAgentId(ref, agentPubkey);
        if (agentId == null) return null;
        final replies = parseAgentDmChatReplies(
          await client.send('GET', agentDmTurnPagePath(agentId)),
        );
        return AgentDmTurnPage(
          replies: replies,
          readAtMs: DateTime.now().millisecondsSinceEpoch,
        );
      } catch (error) {
        debugPrint('[AgentDmTurnSteps] page read failed: ${error.runtimeType}');
        return null;
      }
    });

/// One turn's steps, read while a row shows them open. Throws on a failed
/// read; `ref.invalidate` reads again.
final agentDmTurnStepsProvider = FutureProvider.autoDispose
    .family<AgentDmTurnSteps, ({String agentPubkey, String turnId})>((
      ref,
      key,
    ) async {
      final client = ref.watch(delegationClientProvider);
      final agentId = await _hostedAgentId(ref, key.agentPubkey);
      final turnId = _id(key.turnId);
      if (client == null || agentId == null || turnId == null) {
        throw const DelegationApiException(null, 'agent_not_hosted');
      }
      final steps = parseAgentDmTurnSteps(
        await client.send('GET', agentDmTurnStepsPath(agentId, turnId)),
      );
      if (steps == null) {
        throw const DelegationApiException(null, 'response_malformed');
      }
      return steps;
    });
