import 'package:flutter/foundation.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:uuid/uuid.dart';

import '../agent_commands/agent_commands.dart';
import '../agent_details/agent_summary.dart';
import 'agent_dm_delegation_client.dart';

/// The reader's session with a hosted agent, for a 1:1 DM: what runs it, what
/// they may change, and how full it is. From the host's
/// `GET /agents/<id>/session-setup` on the Buzz mount, the same panel and the
/// same picks as the agent's chat in the other apps. Vitals come only for the
/// session's owner. A change applies from the next turn.

final _uuid = RegExp(
  r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
  caseSensitive: false,
);

String? _text(Object? value) =>
    value is String && value.trim().isNotEmpty ? value.trim() : null;

num? _number(Object? value) => value is num && value.isFinite ? value : null;

@immutable
class AgentDmSetupModel {
  const AgentDmSetupModel({
    required this.id,
    required this.label,
    required this.efforts,
  });

  final String id;
  final String label;

  /// The levels this model allows, low to high.
  final List<String> efforts;
}

@immutable
class AgentDmUsageWindow {
  const AgentDmUsageWindow({
    required this.label,
    required this.remainingPercent,
    this.resetsAt,
  });

  final String label;
  final num remainingPercent;
  final DateTime? resetsAt;
}

@immutable
class AgentDmSessionVitals {
  const AgentDmSessionVitals({
    this.accountAlias,
    this.usageStale = false,
    this.usage = const [],
    this.contextTokens,
    this.contextWindow,
    this.contextPercent,
    this.todosTotal,
    this.todosCompleted = 0,
    this.currentTodo,
    this.costUsd,
    this.branch,
    this.folder,
  });

  final String? accountAlias;
  final bool usageStale;
  final List<AgentDmUsageWindow> usage;
  final num? contextTokens;
  final num? contextWindow;
  final num? contextPercent;
  final num? todosTotal;
  final num todosCompleted;
  final String? currentTodo;
  final num? costUsd;
  final String? branch;
  final String? folder;
}

@immutable
class AgentDmSessionSetup {
  const AgentDmSessionSetup({
    required this.revision,
    required this.model,
    required this.effort,
    required this.label,
    required this.models,
    required this.effortLabels,
    required this.canChangeModel,
    required this.canChangeEffort,
    this.vitals,
  });

  final int revision;
  final String model;
  final String effort;

  /// Server-rendered: "Claude Code · Opus 5.5 · High".
  final String label;
  final List<AgentDmSetupModel> models;
  final Map<String, String> effortLabels;
  final bool canChangeModel;
  final bool canChangeEffort;
  final AgentDmSessionVitals? vitals;

  String effortLabel(String effort) => effortLabels[effort] ?? effort;

  /// The levels the current model allows, low to high.
  List<String> get currentEfforts => [
    for (final option in models)
      if (option.id == model) ...option.efforts,
  ];

  /// The short line for the DM: the label, and how full the context is.
  String get shortText {
    final percent = vitals?.contextPercent;
    return percent == null ? label : '$label · ${percent.round()}%';
  }
}

List<AgentDmUsageWindow> _parseUsage(Map? usage) {
  if (usage == null) return const [];
  return [
    for (final (label, key) in const [
      ('5h', 'five_hour'),
      ('7d', 'seven_day'),
      ('Opus 7d', 'seven_day_opus'),
      ('Sonnet 7d', 'seven_day_sonnet'),
    ])
      if (usage[key] case final Map window)
        if (_number(window['remaining_percent']) case final remaining?)
          AgentDmUsageWindow(
            label: label,
            remainingPercent: remaining,
            resetsAt: DateTime.tryParse(_text(window['resets_at']) ?? ''),
          ),
  ];
}

AgentDmSessionVitals? _parseVitals(Object? body) {
  if (body is! Map) return null;
  final usage = body['account_usage'] is Map
      ? body['account_usage'] as Map
      : null;
  final context = body['context'] is Map ? body['context'] as Map : null;
  final todos = body['todos'] is Map ? body['todos'] as Map : null;
  final location = body['location'] is Map ? body['location'] as Map : null;
  final cost = body['cost'] is Map ? body['cost'] as Map : null;
  final tokens = _number(context?['tokens']);
  final total = _number(todos?['total']);
  final items = [
    if (todos?['items'] case final List list)
      for (final item in list)
        if (item is Map) item,
  ];
  final current =
      items.where((item) => item['status'] == 'in_progress').firstOrNull ??
      items.where((item) => item['status'] == 'pending').firstOrNull;
  final hasContext = tokens != null && tokens > 0;
  final cwd = _text(location?['cwd']);
  final folder = cwd
      ?.replaceAll(RegExp(r'/+$'), '')
      .split('/')
      .where((part) => part.isNotEmpty)
      .lastOrNull;
  return AgentDmSessionVitals(
    accountAlias: _text(usage?['account_alias']),
    usageStale: usage != null && usage['freshness'] != 'fresh',
    usage: _parseUsage(usage),
    contextTokens: hasContext ? tokens : null,
    contextWindow: hasContext ? _number(context?['window']) : null,
    contextPercent: hasContext ? _number(context?['percent']) : null,
    todosTotal: total != null && total > 0 ? total : null,
    todosCompleted: _number(todos?['completed']) ?? 0,
    currentTodo: _text(current?['text']),
    costUsd: _number(cost?['usd']),
    branch: _text(location?['branch']),
    folder: folder,
  );
}

/// The panel in [body], or `null` when the body is not that contract.
AgentDmSessionSetup? parseAgentDmSessionSetup(Object? body) {
  if (body is! Map) return null;
  final current = body['current'];
  if (current is! Map) return null;
  final harness = _text(current['harness']);
  final model = _text(current['model']);
  final effort = _text(current['effort']);
  final label = _text(current['label']);
  final revision = current['revision'];
  if (harness == null ||
      model == null ||
      effort == null ||
      label == null ||
      revision is! int) {
    return null;
  }
  final options = body['options'] is Map ? body['options'] as Map : const {};
  final canChange = body['canChange'] is Map
      ? body['canChange'] as Map
      : const {};
  final entry = [
    if (options['harnesses'] case final List harnesses)
      for (final candidate in harnesses)
        if (candidate is Map && candidate['id'] == harness) candidate,
  ].firstOrNull;
  final models = <AgentDmSetupModel>[
    if (entry?['models'] case final List list)
      for (final raw in list)
        if (raw is Map && _text(raw['id']) != null)
          AgentDmSetupModel(
            id: _text(raw['id'])!,
            label: _text(raw['label']) ?? _text(raw['id'])!,
            efforts: [
              if (raw['efforts'] case final List efforts)
                for (final value in efforts)
                  if (_text(value) != null) _text(value)!,
            ],
          ),
  ];
  return AgentDmSessionSetup(
    revision: revision,
    model: model,
    effort: effort,
    label: label,
    models: models,
    effortLabels: {
      if (options['effortLabels'] case final Map labels)
        for (final entry in labels.entries)
          if (entry.key is String && _text(entry.value) != null)
            entry.key as String: _text(entry.value)!,
    },
    canChangeModel: canChange['model'] == true,
    canChangeEffort: canChange['effort'] == true,
    vitals: _parseVitals(body['vitals']),
  );
}

String _tokenCount(num count) {
  if (count >= 1000000) {
    final value = count / 1000000;
    return value >= 10 ? '${value.round()}M' : '${value.toStringAsFixed(1)}M';
  }
  return count >= 1000 ? '${(count / 1000).round()}k' : '${count.round()}';
}

const _weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

String _clock(DateTime time) {
  final hour = time.hour % 12 == 0 ? 12 : time.hour % 12;
  final minute = time.minute.toString().padLeft(2, '0');
  return '$hour:$minute ${time.hour < 12 ? 'AM' : 'PM'}';
}

String _usageLine(AgentDmUsageWindow window, DateTime now) {
  final left = '${window.label} ${window.remainingPercent.round()}% left';
  final resets = window.resetsAt?.toLocal();
  if (resets == null || !resets.isAfter(now)) return left;
  final sameDay =
      resets.year == now.year &&
      resets.month == now.month &&
      resets.day == now.day;
  final when = sameDay
      ? _clock(resets)
      : '${_weekdays[resets.weekday - 1]} ${_clock(resets)}';
  return '$left · resets $when';
}

/// The vitals in words, the same lines as the agent's chat in the other apps.
List<String> agentDmVitalsLines(AgentDmSessionVitals vitals, {DateTime? now}) {
  final at = now ?? DateTime.now();
  final tokens = vitals.contextTokens;
  final window = vitals.contextWindow;
  final percent = vitals.contextPercent;
  final total = vitals.todosTotal;
  final cost = vitals.costUsd;
  final place = [vitals.folder, vitals.branch].whereType<String>().join(' · ');
  return [
    if (vitals.accountAlias case final alias?)
      vitals.usageStale ? '$alias (may be out of date)' : alias,
    for (final usage in vitals.usage) _usageLine(usage, at),
    if (tokens != null)
      window != null && window > 0 && percent != null
          ? 'Context ${percent.round()}% · ${_tokenCount(tokens)} of ${_tokenCount(window)}'
          : 'Context ${_tokenCount(tokens)}',
    if (total != null) ...[
      'Todos ${vitals.todosCompleted.round()} of ${total.round()}',
      ?vitals.currentTodo,
    ],
    if (cost != null)
      cost < 0.01 ? 'Est. under \$0.01' : 'Est. \$${cost.toStringAsFixed(2)}',
    if (place.isNotEmpty) place,
  ];
}

// ---- Typed commands ----

const _viewCommands = {'status', 'usage', 'context', 'cost'};

/// A whole message that is a session command.
@immutable
class AgentDmSetupCommand {
  const AgentDmSetupCommand(this.name, [this.arg]);

  final String name;

  /// What follows `/model` or `/effort`.
  final String? arg;

  @override
  bool operator ==(Object other) =>
      other is AgentDmSetupCommand && other.name == name && other.arg == arg;

  @override
  int get hashCode => Object.hash(name, arg);
}

final _commandPattern = RegExp(r'^/([a-z]+)(?:\s+(\S.*))?$', dotAll: true);

/// `/model`, `/model <name>`, `/effort`, `/effort <level>`, `/status`,
/// `/usage`, `/context` or `/cost` as the whole message; anything else is an
/// ordinary message, like the session commands the server reads.
AgentDmSetupCommand? parseAgentDmSetupCommand(String message) {
  final match = _commandPattern.firstMatch(message.trim());
  if (match == null) return null;
  final name = match.group(1)!;
  final arg = match.group(2)?.trim();
  if (name == 'model' || name == 'effort') {
    return AgentDmSetupCommand(name, arg);
  }
  return _viewCommands.contains(name) && arg == null
      ? AgentDmSetupCommand(name)
      : null;
}

/// A pick named in a typed command; `id` is null for the default.
@immutable
class AgentDmSetupPick {
  const AgentDmSetupPick(this.id);

  final String? id;

  @override
  bool operator ==(Object other) => other is AgentDmSetupPick && other.id == id;

  @override
  int get hashCode => id.hashCode;
}

AgentDmSetupPick? _matchArg(String arg, Map<String, String> labelsById) {
  final needle = arg.trim().toLowerCase();
  if (needle == 'default') return const AgentDmSetupPick(null);
  for (final entry in labelsById.entries) {
    if (entry.key.toLowerCase() == needle ||
        entry.value.toLowerCase() == needle) {
      return AgentDmSetupPick(entry.key);
    }
  }
  final partial = [
    for (final entry in labelsById.entries)
      if (entry.key.toLowerCase().contains(needle) ||
          entry.value.toLowerCase().contains(needle))
        entry.key,
  ];
  return partial.length == 1 ? AgentDmSetupPick(partial.single) : null;
}

/// What `/model <arg>` names, or null to open the picker (several or none).
AgentDmSetupPick? resolveAgentDmModelArg(
  AgentDmSessionSetup setup,
  String arg,
) => _matchArg(arg, {for (final model in setup.models) model.id: model.label});

/// What `/effort <arg>` names among the current model's levels, or null.
AgentDmSetupPick? resolveAgentDmEffortArg(
  AgentDmSessionSetup setup,
  String arg,
) => _matchArg(arg, {
  for (final effort in setup.currentEfforts) effort: setup.effortLabel(effort),
});

const _commandDescriptions = {
  'model': 'Choose the model for this session.',
  'effort': 'Choose the reasoning level for this session.',
  'status': "Show this session's model, limits and context.",
  'usage': "Show this account's limits.",
  'context': "Show how full this session's context is.",
  'cost': 'Show what this session has used so far.',
};

/// Whether "/" picks [name] as one of this client's session commands.
bool isAgentDmSetupCommandName(String name) =>
    _commandDescriptions.containsKey(name);

/// [commands] with this session's own commands after the server's: they lead
/// a skill of the same name, so a chosen `/model` always means the command.
List<AgentCommand> withAgentDmSetupCommands(
  List<AgentCommand> commands,
  AgentDmSessionSetup? setup,
) {
  if (setup == null) return commands;
  final names = [
    if (setup.canChangeModel) 'model',
    if (setup.canChangeEffort) 'effort',
    ..._viewCommands,
  ];
  final others = [
    for (final command in commands)
      if (!names.contains(command.name)) command,
  ];
  return [
    for (final command in others)
      if (command.kind == AgentCommandKind.session) command,
    for (final name in names)
      AgentCommand.session(
        name: name,
        description: _commandDescriptions[name]!,
      ),
    for (final command in others)
      if (command.kind != AgentCommandKind.session) command,
  ];
}

// ---- The host ----

/// The agent's id on its host, from its summary; null when it has no host.
Future<String?> _hostedAgentId(Ref ref, String agentPubkey) async {
  final summary = await ref.read(
    agentSummaryProvider(agentPubkey.toLowerCase()).future,
  );
  final id = summary?.agentId;
  return id != null && _uuid.hasMatch(id) ? id.toLowerCase() : null;
}

/// The panel for this agent's lowercase key. Null for an agent with no host
/// and after any failure; `ref.invalidate` re-reads it.
final agentDmSessionSetupProvider = FutureProvider.autoDispose
    .family<AgentDmSessionSetup?, String>((ref, agentPubkey) async {
      final client = ref.watch(delegationClientProvider);
      if (client == null) return null;
      try {
        final agentId = await _hostedAgentId(ref, agentPubkey);
        if (agentId == null) return null;
        return parseAgentDmSessionSetup(
          await client.send('GET', 'agents/$agentId/session-setup'),
        );
      } catch (error) {
        debugPrint('[AgentDmSessionSetup] read failed: ${error.runtimeType}');
        return null;
      }
    });

/// What a person does with their session: change it, or stop its turn.
final agentDmSessionActionsProvider = Provider<AgentDmSessionActions>(
  AgentDmSessionActions.new,
);

const _changeErrorSentences = {
  'session_setup_revision_conflict':
      "This session's setup just changed. Look at it again and choose.",
  'session_setup_model_not_allowed': "That model isn't available here.",
  'session_setup_effort_not_allowed':
      "That level isn't available for this model.",
  'session_setup_forbidden': "You can't change this session's setup.",
  'session_setup_off': "Choosing a model isn't available for this agent.",
  'session_setup_not_supported':
      "Choosing a model isn't available for this agent.",
};

/// The plain sentence for a failed change.
String agentDmSetupChangeErrorSentence(Object error) =>
    (error is DelegationApiException
        ? _changeErrorSentences[error.code]
        : null) ??
    "Couldn't change this session's setup. Try again.";

enum AgentDmStopOutcome { stopping, stopped, notRunning }

/// The outcome in a stop answer; anything else means nothing was running.
AgentDmStopOutcome parseAgentDmStopOutcome(Object? body) =>
    switch (body is Map ? body['state'] : null) {
      'stopping' => AgentDmStopOutcome.stopping,
      'stopped' => AgentDmStopOutcome.stopped,
      _ => AgentDmStopOutcome.notRunning,
    };

class AgentDmSessionActions {
  const AgentDmSessionActions(this._ref);

  final Ref _ref;

  /// Change the model or effort: `{'model': id}` or `{'effort': id}`, a null
  /// id resetting it to the default. It applies from the next turn. Throws
  /// when the host refuses; the panel re-reads either way.
  Future<AgentDmSessionSetup> change(
    String agentPubkey,
    AgentDmSessionSetup? before,
    Map<String, String?> choice,
  ) async {
    final key = agentPubkey.toLowerCase();
    final client = _ref.read(delegationClientProvider);
    final agentId = await _hostedAgentId(_ref, key);
    if (client == null || agentId == null) {
      throw const DelegationApiException(null, 'session_setup_not_supported');
    }
    try {
      final answer = await client.send('PUT', 'agents/$agentId/session-setup', {
        'choice': choice,
        'expectedRevision': ?before?.revision,
        'idempotencyKey': const Uuid().v4(),
      });
      final setup = parseAgentDmSessionSetup(
        answer is Map ? answer['setup'] : null,
      );
      if (setup == null) {
        throw const DelegationApiException(null, 'response_malformed');
      }
      return setup;
    } finally {
      _ref.invalidate(agentDmSessionSetupProvider(key));
    }
  }

  /// The requester's stop of the running turn, the same route as the Stop in
  /// the other apps. The session stays.
  Future<AgentDmStopOutcome> stop(String agentPubkey) async {
    final client = _ref.read(delegationClientProvider);
    final agentId = await _hostedAgentId(_ref, agentPubkey);
    if (client == null || agentId == null) {
      throw const DelegationApiException(null, 'agent_not_hosted');
    }
    return parseAgentDmStopOutcome(
      await client.send('POST', 'agents/$agentId/chat/stop', {
        'idempotencyKey': const Uuid().v4(),
      }),
    );
  }
}
