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

/// One speed the session's model offers (the host's `options`), Standard
/// first. [available] false: a fresh check says it isn't on the reader's plan.
/// The cost words are the host's.
@immutable
class AgentDmSpeedOption {
  const AgentDmSpeedOption({
    required this.id,
    this.label,
    this.available,
    this.unavailableReason,
    this.costHint,
  });

  final String id;
  final String? label;
  final bool? available;
  final String? unavailableReason;
  final String? costHint;
}

/// A speed to offer; [note] says why it can't be picked.
@immutable
class AgentDmSpeedRow {
  const AgentDmSpeedRow({
    required this.id,
    required this.label,
    required this.selected,
    this.note,
  });

  final String id;
  final String label;
  final bool selected;
  final String? note;
}

/// One way the session may work (the host's `options.modes`, widest first):
/// Full, Accept edits, Ask or Plan, in the host's words. Only the host decides
/// which can run; this client offers just the ones it marks available.
@immutable
class AgentDmSessionMode {
  const AgentDmSessionMode({
    required this.id,
    required this.label,
    required this.description,
    required this.available,
    this.unavailableReason,
  });

  final String id;
  final String label;
  final String description;
  final bool available;

  /// `use_terminal_mode`: a terminal session keeps its own mode.
  final String? unavailableReason;
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
    this.worktree,
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

  /// The worktree's name, when the session's folder is in a worktree home.
  final String? worktree;
}

@immutable
class AgentDmSessionSetup {
  const AgentDmSessionSetup({
    required this.revision,
    this.harness,
    this.harnesses = const [],
    this.canChangeHarness = false,
    required this.model,
    required this.effort,
    required this.label,
    required this.models,
    required this.effortLabels,
    required this.canChangeModel,
    required this.canChangeEffort,
    this.mode,
    this.modeBeforePlan,
    this.modes = const [],
    this.canChangeMode = false,
    this.vitals,
    this.speed = _standardSpeed,
    this.speeds = const [],
    this.speedLabels = const {},
    this.canChangeSpeed = false,
    this.speedNoteLine,
  });

  final int revision;

  /// The harness it runs, or will run, on.
  final String? harness;

  /// What the next session could run on; provider harnesses aren't offered.
  final List<({String id, String label, bool available})> harnesses;

  /// Only while no session is bound (the host's decision).
  final bool canChangeHarness;
  final String model;
  final String effort;

  /// Server-rendered: "Claude Code · Opus 5.5 · High".
  final String label;
  final List<AgentDmSetupModel> models;
  final Map<String, String> effortLabels;
  final bool canChangeModel;
  final bool canChangeEffort;

  /// The session's mode now (`ceiling`, Full, when none is picked).
  final String? mode;

  /// In Plan: the mode an approved plan returns to.
  final String? modeBeforePlan;

  /// Empty from a host that has no modes.
  final List<AgentDmSessionMode> modes;
  final bool canChangeMode;
  final AgentDmSessionVitals? vitals;

  /// What it runs at now; `standard` from a host that has no speeds.
  final String speed;

  /// The current model's speeds, else the harness's.
  final List<AgentDmSpeedOption> speeds;
  final Map<String, String> speedLabels;
  final bool canChangeSpeed;

  /// "Runs at Fast: Ultrafast isn't on your plan.", when the pick is kept but
  /// doesn't run as chosen.
  final String? speedNoteLine;

  String speedLabel(String id) => _speedLabel(id, speedLabels, speeds);

  /// The speeds to offer; none unless the host lists a choice of them.
  List<AgentDmSpeedRow> get speedRows => speeds.length < 2
      ? const []
      : [
          for (final option in speeds)
            AgentDmSpeedRow(
              id: option.id,
              label: speedLabel(option.id),
              selected: option.id == speed,
              note: option.available == false && option.id != speed
                  ? option.unavailableReason == 'not_on_your_plan'
                        ? 'Not on your plan'
                        : 'Not available'
                  : null,
            ),
        ];

  /// Under the speeds: why the pick runs slower, and what the speed costs.
  String? get speedFooter {
    if (speedRows.isEmpty) return null;
    final selected = speeds.where((option) => option.id == speed).firstOrNull;
    final dearer = speeds
        .where((option) => option.costHint != null)
        .firstOrNull
        ?.costHint;
    final hint =
        selected?.costHint ??
        (speed != _standardSpeed
            ? '${speedLabel(speed)} uses more of your plan than Standard.'
            : dearer != null
            ? 'Faster speeds answer sooner. $dearer'
            : 'Faster speeds answer sooner and use more of your plan.');
    return [?speedNoteLine, hint].join(' ');
  }

  /// The modes the host says this session can run: the only ones offered.
  List<AgentDmSessionMode> get availableModes => [
    for (final option in modes)
      if (option.available) option,
  ];

  /// The words under the mode picks, from the host's own list: what the
  /// current mode does, where an approved plan returns, and what this
  /// harness lacks. A terminal session keeps its own mode, so it says where
  /// to change it.
  String? get modeNote {
    if (modes.any(
      (option) => option.unavailableReason == 'use_terminal_mode',
    )) {
      return 'This terminal session keeps its own mode. Change it in the terminal.';
    }
    final current = modes.where((option) => option.id == mode).firstOrNull;
    if (current == null) return null;
    final returnsTo = modes
        .where((option) => option.id == modeBeforePlan)
        .firstOrNull
        ?.label;
    final missing = [
      for (final option in modes)
        if (!option.available) option.label,
    ];
    return [
      if (current.description.isNotEmpty)
        '${current.label}: ${current.description}.',
      if (returnsTo != null) 'An approved plan returns to $returnsTo.',
      if (missing.isNotEmpty)
        "${missing.join(', ')} isn't available on this harness.",
    ].join(' ');
  }

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
    worktree: _text(location?['worktree']),
  );
}

const _standardSpeed = 'standard';

String _speedLabel(
  String id,
  Map<String, String> labels,
  List<AgentDmSpeedOption> speeds,
) =>
    labels[id] ??
    speeds.where((option) => option.id == id).firstOrNull?.label ??
    (id.isEmpty ? id : '${id[0].toUpperCase()}${id.substring(1)}');

/// A list of speeds, or null when absent; an unreadable one is left out.
List<AgentDmSpeedOption>? _parseSpeeds(Object? value) => value is! List
    ? null
    : [
        for (final raw in value)
          if (raw is String && _text(raw) != null)
            AgentDmSpeedOption(id: _text(raw)!)
          else if (raw is Map && _text(raw['id']) != null)
            AgentDmSpeedOption(
              id: _text(raw['id'])!,
              label: _text(raw['label']),
              available: raw['available'] is bool
                  ? raw['available'] as bool
                  : null,
              unavailableReason: _text(raw['unavailableReason']),
              costHint: _text(raw['costHint']),
            ),
      ];

String? _speedNoteLine(
  Object? value,
  Map<String, String> labels,
  List<AgentDmSpeedOption> speeds,
) {
  if (value is! Map) return null;
  final chosen = _text(value['chosen']);
  final runsAt = _text(value['runsAt']);
  if (chosen == null || runsAt == null || chosen == runsAt) return null;
  final name = _speedLabel(chosen, labels, speeds);
  final why = switch (value['reason']) {
    'not_on_your_plan' => "$name isn't on your plan.",
    'model' => "this model doesn't offer $name.",
    'payer' => "$name isn't allowed on this session's plan.",
    _ => "$name isn't available.",
  };
  return 'Runs at ${_speedLabel(runsAt, labels, speeds)}: $why';
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
  final modes = <AgentDmSessionMode>[
    if (options['modes'] case final List list)
      for (final raw in list)
        if (raw is Map && _text(raw['id']) != null)
          AgentDmSessionMode(
            id: _text(raw['id'])!,
            label: _text(raw['label']) ?? _text(raw['id'])!,
            description: _text(raw['description']) ?? '',
            available: raw['available'] == true,
            unavailableReason: _text(raw['unavailableReason']),
          ),
  ];
  final currentModel = [
    if (entry?['models'] case final List list)
      for (final raw in list)
        if (raw is Map && raw['id'] == model) raw,
  ].firstOrNull;
  final speeds =
      _parseSpeeds(currentModel?['speeds']) ??
      _parseSpeeds(entry?['speeds']) ??
      const <AgentDmSpeedOption>[];
  final speedLabels = <String, String>{
    if (options['speedLabels'] case final Map labels)
      for (final entry in labels.entries)
        if (entry.key is String && _text(entry.value) != null)
          entry.key as String: _text(entry.value)!,
  };
  return AgentDmSessionSetup(
    revision: revision,
    harness: harness,
    // OpenCode and Pi need a connection and model pick this sheet doesn't have.
    harnesses: [
      if (options['harnesses'] case final List list)
        for (final raw in list)
          if (raw is Map)
            if (_text(raw['id']) case final id?
                when id != 'opencode' && id != 'pi')
              (
                id: id,
                label: _text(raw['label']) ?? id,
                available: raw['available'] == true,
              ),
    ],
    canChangeHarness: canChange['harness'] == true,
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
    mode: _text(current['mode']),
    modeBeforePlan: _text(current['modeBeforePlan']),
    modes: modes,
    canChangeMode: canChange['mode'] == true && modes.isNotEmpty,
    vitals: _parseVitals(body['vitals']),
    speed: _text(current['speed']) ?? _standardSpeed,
    speeds: speeds,
    speedLabels: speedLabels,
    canChangeSpeed: canChange['speed'] == true,
    speedNoteLine: _speedNoteLine(current['speedNote'], speedLabels, speeds),
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
  final worktree = vitals.worktree;
  final place = [
    if (worktree != vitals.folder) vitals.folder,
    vitals.branch,
    if (worktree != null) 'worktree $worktree',
  ].whereType<String>().join(' · ');
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

  /// What follows `/model`, `/effort` or `/speed`.
  final String? arg;

  @override
  bool operator ==(Object other) =>
      other is AgentDmSetupCommand && other.name == name && other.arg == arg;

  @override
  int get hashCode => Object.hash(name, arg);
}

final _commandPattern = RegExp(r'^/([a-z]+)(?:\s+(\S.*))?$', dotAll: true);

/// `/model`, `/model <name>`, `/effort`, `/effort <level>`, `/speed`,
/// `/speed <speed>`, `/fast`, `/status`, `/usage`, `/context` or `/cost` as
/// the whole message; anything else is an ordinary message, like the session
/// commands the server reads.
AgentDmSetupCommand? parseAgentDmSetupCommand(String message) {
  final match = _commandPattern.firstMatch(message.trim());
  if (match == null) return null;
  final name = match.group(1)!;
  final arg = match.group(2)?.trim();
  if (name == 'model' || name == 'effort' || name == 'speed') {
    return AgentDmSetupCommand(name, arg);
  }
  return (_viewCommands.contains(name) || name == 'fast') && arg == null
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

/// A speed that can be picked: a null id is Standard. Null when it can't.
AgentDmSetupPick? _speedPick(AgentDmSessionSetup setup, String id) {
  final row = setup.speedRows.where((row) => row.id == id).firstOrNull;
  if (row == null || row.note != null) return null;
  return AgentDmSetupPick(id == _standardSpeed ? null : id);
}

/// What `/speed <arg>` names, or null to open the panel (several, none or a
/// refused one).
AgentDmSetupPick? resolveAgentDmSpeedArg(
  AgentDmSessionSetup setup,
  String arg,
) {
  final named = _matchArg(arg, {
    for (final row in setup.speedRows) row.id: row.label,
  });
  final id = named?.id;
  return id == null ? named : _speedPick(setup, id);
}

/// `/fast`: Standard to Fast, anything else back to Standard. Null to open the
/// panel.
AgentDmSetupPick? agentDmFastTogglePick(AgentDmSessionSetup setup) =>
    _speedPick(setup, setup.speed == _standardSpeed ? 'fast' : _standardSpeed);

/// Whether a typed session command is this session's: `/speed` and `/fast` only
/// where the host lists a choice of speeds, so elsewhere they stay ordinary
/// messages (a skill of that name still runs).
bool agentDmSetupCommandApplies(
  AgentDmSessionSetup setup,
  AgentDmSetupCommand command,
) =>
    (command.name != 'speed' && command.name != 'fast') ||
    setup.speedRows.isNotEmpty;

const _commandDescriptions = {
  'model': 'Choose the model for this session.',
  'effort': 'Choose the reasoning level for this session.',
  'speed': 'Choose the speed for this session.',
  'fast': 'Switch this session between Standard and Fast.',
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
    if (setup.canChangeSpeed && setup.speedRows.isNotEmpty) ...[
      'speed',
      'fast',
    ],
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
  'session_setup_mode_not_supported': "This session can't run that mode.",
  'session_setup_speed_not_allowed':
      "That speed isn't available for this model.",
  'session_setup_speed_unavailable': "That speed isn't on your plan.",
  'session_setup_harness_unavailable': "That harness isn't available here.",
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

  /// Change the model, effort, speed or mode: `{'model': id}`,
  /// `{'effort': id}`, `{'speed': id}` or `{'mode': id}`, a null model, effort
  /// or speed resetting it to the default; a mode is sent only on an explicit
  /// pick. It applies from the next turn.
  /// Throws when the host refuses; the panel re-reads either way.
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
