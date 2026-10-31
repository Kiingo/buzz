import 'package:flutter/foundation.dart';

/// The owner's delegation board in a 1:1 agent DM (delegation-driven agents
/// §10.1, Kiingo `delegation-views.interface.ts`): an agent hands work to
/// worker sessions, and the DM shows them as quiet cards that update in
/// place, never as new messages. The same rules as desktop's
/// `desktop/src/features/agent-dm/lib/delegations.ts`.
///
/// Wire: `GET /api/buzz-voice/ios/agents/-/delegations?agentPubkey=<hex>`
/// (the host resolves the Buzz agent key as its settings read does),
/// long-polled with `rev` + `wait`, owner-only (D5). The owner's chat page
/// (`GET …/agents/<agentId>/chat`) adds the pending ack. Every reader here
/// fails closed: a malformed card is dropped, a malformed page is no page.

/// The long-poll ceiling the host allows (DELEGATION_CARDS_MAX_WAIT_SEC).
const delegationWaitSeconds = 20;

/// Three or more running cards fold into one row (§10.1).
const delegationFoldAt = 3;

enum DelegationState {
  queued,
  running,
  needsInput,
  blocked,
  done,
  failed,
  cancelled;

  static DelegationState? tryParse(Object? value) => switch (value) {
    'queued' => queued,
    'running' => running,
    'needs_input' => needsInput,
    'blocked' => blocked,
    'done' => done,
    'failed' => failed,
    'cancelled' => cancelled,
    _ => null,
  };

  bool get isActive =>
      this == queued ||
      this == running ||
      this == needsInput ||
      this == blocked;
}

final _uuid = RegExp(
  r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
  caseSensitive: false,
);

bool isDelegationUuid(Object? value) =>
    value is String && _uuid.hasMatch(value);

String? _uuidOrNull(Object? value) =>
    isDelegationUuid(value) ? (value as String).toLowerCase() : null;

String? _text(Object? value) =>
    value is String && value.trim().isNotEmpty ? value.trim() : null;

double? _number(Object? value) =>
    value is num && value.isFinite ? value.toDouble() : null;

int _count(Object? value) {
  final n = _number(value);
  return n != null && n > 0 ? n.floor() : 0;
}

Map<String, Object?>? _map(Object? value) =>
    value is Map ? value.cast<String, Object?>() : null;

@immutable
class DelegationResult {
  const DelegationResult({required this.summary, required this.outcome});

  final String summary;

  /// `done`, `failed` or `cancelled`.
  final String outcome;
}

@immutable
class DelegationCard {
  const DelegationCard({
    required this.delegationId,
    required this.title,
    required this.state,
    this.harness,
    this.stalled = false,
    this.taskId,
    this.taskTitle,
    this.workerSessionId,
    this.startedAt,
    this.finishedAt,
    this.elapsedSeconds,
    this.costUsd,
    this.doneWhen,
    this.lastProgressLine,
    this.result,
    this.pendingAsksCount = 0,
  });

  final String delegationId;
  final String title;
  final DelegationState state;

  /// `claude_code` or `codex`.
  final String? harness;
  final bool stalled;
  final String? taskId;
  final String? taskTitle;
  final String? workerSessionId;
  final String? startedAt;
  final String? finishedAt;
  final double? elapsedSeconds;
  final double? costUsd;
  final String? doneWhen;

  /// Interim only; never shown as a result (§16.4).
  final String? lastProgressLine;
  final DelegationResult? result;
  final int pendingAsksCount;

  bool get isActive => state.isActive;

  /// Waiting on the owner: an open ask, or `needs_input`.
  bool get needsYou =>
      isActive && (state == DelegationState.needsInput || pendingAsksCount > 0);

  static DelegationCard? tryParse(Object? value) {
    final record = _map(value);
    if (record == null) return null;
    final id = _uuidOrNull(record['delegationId']);
    final title = _text(record['title']);
    final state = DelegationState.tryParse(record['state']);
    if (id == null || title == null || state == null) return null;
    final harness = record['harness'];
    DelegationResult? result;
    final rawResult = _map(record['result']);
    final summary = _text(rawResult?['summary']);
    final outcome = rawResult?['outcome'];
    if (!state.isActive &&
        summary != null &&
        (outcome == 'done' || outcome == 'failed' || outcome == 'cancelled')) {
      result = DelegationResult(summary: summary, outcome: outcome as String);
    }
    return DelegationCard(
      delegationId: id,
      title: title,
      state: state,
      harness: harness == 'claude_code' || harness == 'codex'
          ? harness as String
          : null,
      stalled: record['stalled'] == true && state == DelegationState.running,
      taskId: _uuidOrNull(record['taskId']),
      taskTitle: _text(record['taskTitle']),
      workerSessionId: _uuidOrNull(record['workerSessionId']),
      startedAt: _text(record['startedAt']),
      finishedAt: _text(record['finishedAt']),
      elapsedSeconds: _number(record['elapsedSeconds']),
      costUsd: _number(_map(record['cost'])?['costUsd']),
      doneWhen: _text(record['doneWhen']),
      lastProgressLine: _text(record['lastProgressLine']),
      result: result,
      pendingAsksCount: _count(record['pendingAsksCount']),
    );
  }
}

@immutable
class DelegationSummary {
  const DelegationSummary({
    this.runningCount = 0,
    this.needsYouCount = 0,
    this.stalledCount = 0,
    this.costTodayUsd,
    this.canStopAll = false,
  });

  final int runningCount;
  final int needsYouCount;
  final int stalledCount;
  final double? costTodayUsd;
  final bool canStopAll;
}

@immutable
class DelegationPage {
  const DelegationPage({
    required this.rev,
    required this.serverNow,
    required this.agentId,
    required this.agentName,
    required this.summary,
    required this.cards,
  });

  final String rev;
  final String serverNow;

  /// The Kiingo agent behind the key: the id the per-delegation routes use.
  final String? agentId;
  final String agentName;
  final DelegationSummary summary;
  final List<DelegationCard> cards;
}

/// One long-poll answer: a page, or `unchanged` with its rev.
@immutable
class DelegationPoll {
  const DelegationPoll({required this.rev, this.page});

  final String rev;

  /// Null when unchanged.
  final DelegationPage? page;

  static DelegationPoll? tryParse(Object? value) {
    final record = _map(value);
    final rev = _text(record?['rev']);
    if (record == null || rev == null) return null;
    if (record['unchanged'] == true) return DelegationPoll(rev: rev);
    final summary = _map(record['summary']);
    final rawCards = record['cards'];
    if (summary == null || rawCards is! List) return null;
    final seen = <String>{};
    final cards = <DelegationCard>[];
    for (final raw in rawCards) {
      final card = DelegationCard.tryParse(raw);
      if (card == null || !seen.add(card.delegationId)) continue;
      cards.add(card);
    }
    return DelegationPoll(
      rev: rev,
      page: DelegationPage(
        rev: rev,
        serverNow: _text(record['serverNow']) ?? '',
        agentId: _uuidOrNull(_map(record['agent'])?['id']),
        agentName: _text(_map(record['agent'])?['name']) ?? '',
        summary: DelegationSummary(
          runningCount: _count(summary['runningCount']),
          needsYouCount: _count(summary['needsYouCount']),
          stalledCount: _count(summary['stalledCount']),
          costTodayUsd: _number(summary['costTodayUsd']),
          canStopAll: summary['canStopAll'] == true,
        ),
        cards: List.unmodifiable(cards),
      ),
    );
  }
}

/// A worker's question to its orchestrator, answered here by the owner.
@immutable
class DelegationAsk {
  const DelegationAsk({
    required this.id,
    required this.delegationId,
    required this.workerTitle,
    required this.question,
    required this.options,
    this.recommendation,
  });

  final String id;
  final String delegationId;
  final String workerTitle;
  final String question;
  final List<String> options;
  final String? recommendation;

  /// "from worker: <title>" (§10.1).
  String get fromWorkerLabel =>
      'from worker: ${workerTitle.isEmpty ? 'worker' : workerTitle}';
}

/// The open asks of `GET …/delegations/<id>` (IDelegationDetailResponse).
List<DelegationAsk> parseDelegationAsks(Object? value) {
  final raw = _map(_map(value)?['delegation'])?['pendingAsks'];
  if (raw is! List) return const [];
  final asks = <DelegationAsk>[];
  for (final entry in raw) {
    final record = _map(entry);
    final id = _uuidOrNull(record?['id']);
    final delegationId = _uuidOrNull(record?['delegationId']);
    final question = _text(record?['question']);
    if (record == null || id == null || delegationId == null) continue;
    if (question == null) continue;
    final state = record['state'];
    if (state != null && state != 'open') continue;
    final options = <String>[];
    final rawOptions = record['options'];
    if (rawOptions is List) {
      for (final option in rawOptions) {
        final label = _text(option);
        if (label != null && !options.contains(label)) options.add(label);
      }
    }
    asks.add(
      DelegationAsk(
        id: id,
        delegationId: delegationId,
        workerTitle: _text(record['workerTitle']) ?? '',
        question: question,
        options: List.unmodifiable(options),
        recommendation: _text(record['recommendation']),
      ),
    );
  }
  return asks;
}

const _stateLabels = {
  DelegationState.queued: 'queued',
  DelegationState.running: 'running',
  DelegationState.needsInput: 'needs you',
  DelegationState.blocked: 'blocked',
  DelegationState.done: 'done',
  DelegationState.failed: 'failed',
  DelegationState.cancelled: 'stopped',
};

String delegationStateLabel(DelegationCard card) {
  if (card.stalled) return 'stalled';
  return card.needsYou ? 'needs you' : _stateLabels[card.state]!;
}

String? delegationHarnessLabel(String? harness) => switch (harness) {
  'claude_code' => 'Claude',
  'codex' => 'Codex',
  _ => null,
};

/// `$4.10`, or null when there is no cost to show.
String? formatDelegationUsd(double? value) {
  if (value == null || value <= 0) return null;
  return value < 0.01 ? r'<$0.01' : '\$${value.toStringAsFixed(2)}';
}

/// `45s`, `12m`, `1h 05m`.
String? formatDelegationElapsed(double? seconds) {
  if (seconds == null || seconds < 0) return null;
  final s = seconds.floor();
  if (s < 60) return '${s}s';
  final minutes = s ~/ 60;
  if (minutes < 60) return '${minutes}m';
  return '${minutes ~/ 60}h ${(minutes % 60).toString().padLeft(2, '0')}m';
}

/// A running card's elapsed time at [now]: the server's figure at
/// `serverNow`, plus the time since. Finished cards keep the server's.
double? delegationLiveElapsed(
  DelegationCard card,
  String serverNow,
  DateTime now,
) {
  final base = card.elapsedSeconds;
  if (base == null) return null;
  if (!card.isActive || card.state == DelegationState.queued) return base;
  final at = DateTime.tryParse(serverNow);
  if (at == null) return base;
  final since = now.difference(at).inMilliseconds / 1000;
  return base + (since > 0 ? since : 0);
}

/// The thread header: "3 running · 1 needs you · $4.10 today", or null.
String? delegationHeaderText(DelegationSummary summary) {
  final parts = <String>[
    if (summary.runningCount > 0) '${summary.runningCount} running',
    if (summary.needsYouCount > 0) '${summary.needsYouCount} needs you',
    if (summary.stalledCount > 0) '${summary.stalledCount} stalled',
  ];
  if (parts.isEmpty) return null;
  final cost = formatDelegationUsd(summary.costTodayUsd);
  if (cost != null) parts.add('$cost today');
  return parts.join(' · ');
}

enum DelegationOutcome { done, failed, mixed }

/// One finished task: every worker that finished on it.
@immutable
class DelegationTaskSummary {
  const DelegationTaskSummary({
    required this.key,
    required this.taskId,
    required this.title,
    required this.outcome,
    required this.workers,
  });

  final String key;
  final String? taskId;
  final String title;
  final DelegationOutcome outcome;
  final List<DelegationCard> workers;

  String get heading {
    final label = switch (outcome) {
      DelegationOutcome.done => 'Done',
      DelegationOutcome.failed => 'Didn’t finish',
      DelegationOutcome.mixed => 'Finished',
    };
    return title.isEmpty ? label : '$label · $title';
  }
}

@immutable
class DelegationBoard {
  const DelegationBoard({
    required this.needsYou,
    required this.running,
    required this.done,
  });

  /// Cards waiting on the owner, newest first.
  final List<DelegationCard> needsYou;

  /// Every other active card, newest first.
  final List<DelegationCard> running;

  /// Finished work, one summary per task, newest first.
  final List<DelegationTaskSummary> done;

  bool get folded => running.length >= delegationFoldAt;
  bool get isEmpty => needsYou.isEmpty && running.isEmpty && done.isEmpty;
}

int _newest(String? a, String? b) => (b ?? '').compareTo(a ?? '');

/// The board from a page. A task shows its done summary only once none of
/// its workers is still active; [hidden] holds the ones put away (by key).
DelegationBoard delegationBoard(
  List<DelegationCard> cards, {
  Set<String> hidden = const {},
}) {
  final active = cards.where((card) => card.isActive).toList();
  final asking = active.where((card) => card.needsYou).toList()
    ..sort((a, b) => _newest(a.startedAt, b.startedAt));
  final running = active.where((card) => !card.needsYou).toList()
    ..sort((a, b) => _newest(a.startedAt, b.startedAt));
  final activeTasks = {
    for (final card in active)
      if (card.taskId != null) card.taskId!,
  };
  final groups = <String, List<DelegationCard>>{};
  for (final card in cards) {
    if (card.isActive) continue;
    if (card.taskId != null && activeTasks.contains(card.taskId)) continue;
    groups.putIfAbsent(card.taskId ?? card.delegationId, () => []).add(card);
  }
  final done = <DelegationTaskSummary>[];
  for (final MapEntry(:key, value: workers) in groups.entries) {
    if (hidden.contains(key)) continue;
    workers.sort((a, b) => _newest(a.finishedAt, b.finishedAt));
    final outcomes = {
      for (final card in workers)
        card.state == DelegationState.done ? 'done' : 'failed',
    };
    final first = workers.first;
    done.add(
      DelegationTaskSummary(
        key: key,
        taskId: first.taskId,
        title: first.taskTitle ?? first.title,
        outcome: outcomes.length > 1
            ? DelegationOutcome.mixed
            : outcomes.contains('done')
            ? DelegationOutcome.done
            : DelegationOutcome.failed,
        workers: List.unmodifiable(workers),
      ),
    );
  }
  done.sort(
    (a, b) => _newest(a.workers.first.finishedAt, b.workers.first.finishedAt),
  );
  return DelegationBoard(needsYou: asking, running: running, done: done);
}

/// `kiingotasks://task/<id>` (Kiingo Tasks opens the task).
String delegationTaskLink(String taskId) =>
    'kiingotasks://task/${taskId.toLowerCase()}';

/// The web app beside the agent host (`https://api.kiingo.com` →
/// `https://app.kiingo.com`), where a worker's session opens; else null.
String? delegationAppOrigin(String? apiOrigin) {
  final uri = apiOrigin == null ? null : Uri.tryParse(apiOrigin);
  final host = uri?.host.toLowerCase() ?? '';
  if (uri?.scheme != 'https' ||
      !RegExp(r'^api\.[a-z0-9.-]+$').hasMatch(host) ||
      host.contains('..')) {
    return null;
  }
  return 'https://app.${host.substring(4)}';
}

String delegationSessionLink(String appOrigin, String sessionId) =>
    '$appOrigin/team/harness-sessions/${sessionId.toLowerCase()}/feed';

/// The cards list path for a Buzz agent key (the host resolves it),
/// long-polled on [rev] after the first read.
String delegationsPath(String agentPubkey, String? rev) {
  final base = 'agents/-/delegations?agentPubkey=${agentPubkey.toLowerCase()}';
  return rev == null
      ? base
      : '$base&rev=${_encodeRev(rev)}'
            '&wait=$delegationWaitSeconds';
}

/// The newest page of the owner's chat: it carries the pending ack.
String delegationChatPath(String agentId) =>
    'agents/${agentId.toLowerCase()}/chat?limit=1';

/// The server's instant acknowledgement (IDelegationPendingAck): workers
/// the agent started this turn, shown until its own reply lands. Transient:
/// a page without it, or with another id, drops it.
@immutable
class DelegationPendingAck {
  const DelegationPendingAck({
    required this.id,
    required this.text,
    required this.expiresAt,
  });

  final String id;

  /// "Starting 2 workers: Fix the login bug, Draft the launch email".
  final String text;

  /// After this the row goes even without a fresh page.
  final DateTime expiresAt;

  /// The pending ack on an owner chat page, or null (absent, bad or past).
  static DelegationPendingAck? tryParse(Object? chatPage, DateTime now) {
    final ack = _map(_map(_map(chatPage)?['delegations'])?['pendingAck']);
    final id = _text(ack?['id']);
    final text = _text(ack?['text']);
    final expiresAt = DateTime.tryParse(_text(ack?['expiresAt']) ?? '');
    if (id == null || text == null || expiresAt == null) return null;
    if (!expiresAt.isAfter(now)) return null;
    return DelegationPendingAck(
      id: id,
      text: text.length > 500 ? text.substring(0, 500) : text,
      expiresAt: expiresAt,
    );
  }

  @override
  bool operator ==(Object other) =>
      other is DelegationPendingAck && other.id == id && other.text == text;

  @override
  int get hashCode => Object.hash(id, text);
}

/// `rev` percent-encoded down to letters, digits and `-_.`, as desktop
/// sends it (its native route check refuses `!'()*~`).
String _encodeRev(String rev) => Uri.encodeComponent(rev).replaceAllMapped(
  RegExp(r"[!'()*~]"),
  (match) => '%${match[0]!.codeUnitAt(0).toRadixString(16).toUpperCase()}',
);
