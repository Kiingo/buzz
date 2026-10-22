import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../theme/theme_provider.dart';
import 'hosted_agent_catalog.dart';
import 'hosted_agent_client.dart';
import 'hosted_agent_errors.dart';
import 'hosted_agent_snapshot.dart';
import 'hosted_owner_attest.dart';
import 'hosted_owner_rebind.dart';

// "Auto-link my new agents": an owner setting, off by default. While it is
// on and the app is in the foreground, Buzz lists the owner's hosted agents
// on launch, on resume and every 15 minutes, attests every agent the list
// reports as pending, re-links every agent still on an earlier owner key,
// and then shows one quiet note naming the agents it linked. Only agents the
// authenticated list returned are ever signed for, and a pass stops before
// its next signed request once the setting is turned off or the key changes.
// Repeated whole-request failures back off, with one plain note.

/// Passes repeat this often while the app is in the foreground.
const hostedAutoLinkInterval = Duration(minutes: 15);

/// A resume within this long of the last pass does not start another.
const hostedAutoLinkResumeGap = Duration(minutes: 1);

const _settingPrefix = 'hosted_agents.auto_link.v1:';
final _hex64 = RegExp(r'^[0-9a-f]{64}$');

/// The stored-setting key for [ownerPublicKey], or `null` for a bad key.
String? hostedAutoLinkSettingKey(String ownerPublicKey) {
  final owner = ownerPublicKey.toLowerCase();
  return _hex64.hasMatch(owner) ? '$_settingPrefix$owner' : null;
}

/// The signed-in key's auto-link setting on this device (off by default).
class HostedAutoLinkSetting extends Notifier<bool> {
  String? _key;

  @override
  bool build() {
    final client = ref.watch(hostedAgentClientProvider);
    String? owner;
    try {
      owner = client?.ownerPublicKey();
    } on HostedAgentException {
      owner = null;
    }
    _key = owner == null ? null : hostedAutoLinkSettingKey(owner);
    final key = _key;
    if (key == null) return false;
    return ref.read(savedPrefsProvider).getBool(key) ?? false;
  }

  /// Turn auto-link on or off for the signed-in key. Off removes the value.
  Future<void> set(bool enabled) async {
    final key = _key;
    if (key == null) return;
    state = enabled;
    final prefs = ref.read(savedPrefsProvider);
    if (enabled) {
      await prefs.setBool(key, true);
    } else {
      await prefs.remove(key);
    }
  }
}

final hostedAutoLinkSettingProvider =
    NotifierProvider<HostedAutoLinkSetting, bool>(HostedAutoLinkSetting.new);

/// The three calls one pass makes.
abstract interface class HostedAutoLinkApi {
  Future<List<HostedAgentSnapshot>> list();

  Future<List<HostedAttestOutcome>> attestPending(
    List<HostedAgentSnapshot> agents,
  );

  Future<List<HostedRebindOutcome>> rebind(List<HostedAgentSnapshot> agents);
}

/// What earlier passes learned: agents the provider refused for good, keyed
/// by owner key, agent id and agent key, so a pass does not sign for them
/// again every 15 minutes. Kept in memory only; a restart tries once more.
class HostedAutoLinkMemory {
  final Set<String> refused = {};

  static String keyFor(String owner, HostedAgentSnapshot agent) =>
      '${owner.toLowerCase()}|${agent.providerAgentId}|${agent.agentPublicKey}';
}

/// An agent a pass could not link for good, and why, in plain words.
@immutable
class HostedAutoLinkRefusal {
  const HostedAutoLinkRefusal({required this.name, required this.reason});

  /// The agent's name and key fingerprint.
  final String name;
  final String reason;

  @override
  bool operator ==(Object other) =>
      other is HostedAutoLinkRefusal &&
      other.name == name &&
      other.reason == reason;

  @override
  int get hashCode => Object.hash(name, reason);

  @override
  String toString() => 'HostedAutoLinkRefusal($name: $reason)';
}

/// The result of one pass.
@immutable
class HostedAutoLinkResult {
  const HostedAutoLinkResult({
    this.linked = const [],
    this.notLinked = const [],
    this.errors = const [],
    this.sent = false,
    this.cancelled = false,
  });

  /// Agents this pass attested or re-linked, in list order, each as its
  /// name and key fingerprint.
  final List<String> linked;

  /// Agents this pass could not link for good. Each is reported once:
  /// refused agents are not sent again.
  final List<HostedAutoLinkRefusal> notLinked;

  /// Whole-request error codes, if a request failed.
  final List<String> errors;

  /// Whether the pass sent any request after listing.
  final bool sent;

  /// Whether `shouldContinue` stopped the pass before it finished.
  final bool cancelled;
}

List<List<T>> _chunk<T>(List<T> items, int size) => [
  for (var index = 0; index < items.length; index += size)
    items.sublist(
      index,
      index + size > items.length ? items.length : index + size,
    ),
];

/// One auto-link pass for [ownerPublicKey]: list, attest the pending
/// agents, re-link the stale ones, in requests of at most 20 agents, each a
/// new request id and proof. A whole-request failure stops the pass; the
/// next pass starts over from a fresh list. [shouldContinue] is checked
/// after the list and before every signed request: false (the setting was
/// turned off, the owner signed out or switched keys) stops the pass
/// without signing anything more.
Future<HostedAutoLinkResult> runHostedAutoLinkPass({
  required HostedAutoLinkApi api,
  required String ownerPublicKey,
  required HostedAutoLinkMemory memory,
  bool Function()? shouldContinue,
}) async {
  final List<HostedAgentSnapshot> agents;
  try {
    agents = await api.list();
  } on HostedAgentException catch (error) {
    return HostedAutoLinkResult(errors: [error.code]);
  }
  final owner = ownerPublicKey.toLowerCase();
  bool fresh(HostedAgentSnapshot agent) =>
      !memory.refused.contains(HostedAutoLinkMemory.keyFor(owner, agent));
  final pending = pendingHostedAgents(agents).where(fresh).toList();
  final stale = staleHostedAgents(agents, owner).where(fresh).toList();
  final linked = <String>{};
  final notLinked = <HostedAutoLinkRefusal>[];
  final errors = <String>[];
  var sent = false;
  var cancelled = false;
  bool keepGoing() {
    if (shouldContinue != null && !shouldContinue()) cancelled = true;
    return !cancelled;
  }

  void refuse(HostedAgentSnapshot agent, String reason) {
    memory.refused.add(HostedAutoLinkMemory.keyFor(owner, agent));
    notLinked.add(
      HostedAutoLinkRefusal(name: agent.fingerprintedName, reason: reason),
    );
  }

  try {
    for (final batch in _chunk(pending, hostedRebindMaxAgents)) {
      if (!keepGoing()) break;
      sent = true;
      final outcomes = {
        for (final outcome in await api.attestPending(batch))
          outcome.providerAgentId: outcome,
      };
      for (final agent in batch) {
        final outcome = outcomes[agent.providerAgentId];
        if (outcome != null && outcome.linked) {
          // Already active means another device or tap linked it.
          if (outcome.status != HostedAttestStatus.alreadyActive) {
            linked.add(agent.providerAgentId);
          }
        } else if (outcome == null || !outcome.retryable) {
          refuse(agent, describeAttestRejection(outcome?.code));
        }
      }
    }
    for (final batch in _chunk(stale, hostedRebindMaxAgents)) {
      if (!keepGoing()) break;
      sent = true;
      final outcomes = {
        for (final outcome in await api.rebind(batch))
          outcome.providerAgentId: outcome,
      };
      for (final agent in batch) {
        final outcome = outcomes[agent.providerAgentId];
        if (outcome?.status == HostedRebindStatus.rebound) {
          linked.add(agent.providerAgentId);
        } else if (outcome?.status != HostedRebindStatus.alreadyCurrent &&
            !(outcome?.retryable ?? false)) {
          refuse(agent, describeRebindRejection(outcome?.code));
        }
      }
    }
  } on HostedAgentException catch (error) {
    errors.add(error.code);
  }
  return HostedAutoLinkResult(
    linked: List.unmodifiable([
      for (final agent in agents)
        if (linked.contains(agent.providerAgentId)) agent.fingerprintedName,
    ]),
    notLinked: List.unmodifiable(notLinked),
    errors: List.unmodifiable(errors),
    sent: sent,
    cancelled: cancelled,
  );
}

/// The quiet note after a pass, or `null` when it linked nothing.
String? hostedAutoLinkNote(List<String> names) {
  if (names.isEmpty) return null;
  if (names.length <= 4) return 'Linked: ${names.join(', ')}';
  return 'Linked: ${names.take(3).join(', ')} and ${names.length - 3} more';
}

/// The note for agents a pass could not link, or `null` when there are
/// none: one "name: reason" line per agent, at most three, then a count.
String? hostedAutoLinkRefusedNote(List<HostedAutoLinkRefusal> agents) {
  if (agents.isEmpty) return null;
  final title = agents.length == 1
      ? "Couldn't link an agent"
      : "Couldn't link ${agents.length} agents";
  final lines = [
    title,
    for (final agent in agents.take(3))
      '${_printableOr(agent.name, 'An agent')}: ${agent.reason}',
    if (agents.length > 3) 'And ${agents.length - 3} more.',
  ];
  return lines.join('\n');
}

String _printableOr(String name, String fallback) {
  final printable = hostedAgentPrintableName(name);
  return printable.isEmpty ? fallback : printable;
}

/// Whole-request failures in a row before passes back off and say so.
const hostedAutoLinkFailuresBeforeBackoff = 3;

/// The first wait after that; each further failure doubles it.
const hostedAutoLinkBackoffBase = Duration(minutes: 30);

/// The longest wait between passes that keep failing.
const hostedAutoLinkBackoffMax = Duration(hours: 8);

/// Backs off passes that keep failing as a whole (offline, a signature the
/// service refuses, the service down): after three failures in a row, the
/// next pass waits 30 minutes, then an hour, up to eight hours, and one
/// plain note says so. A pass that gets through resets it.
class HostedAutoLinkBackoff {
  int _failures = 0;
  DateTime? _notBefore;

  /// Consecutive whole-request failures so far.
  int get failures => _failures;

  /// Whether a pass may start at [now].
  bool allows(DateTime now) {
    final notBefore = _notBefore;
    return notBefore == null || !now.isBefore(notBefore);
  }

  /// Record a finished pass. Returns the note to show, once per run of
  /// failures, or `null`.
  String? record(HostedAutoLinkResult result, DateTime now) {
    if (result.cancelled) return null;
    if (result.errors.isEmpty) {
      _failures = 0;
      _notBefore = null;
      return null;
    }
    _failures += 1;
    if (_failures < hostedAutoLinkFailuresBeforeBackoff) return null;
    final steps = _failures - hostedAutoLinkFailuresBeforeBackoff;
    // Capped before shifting, so a long run of failures cannot overflow.
    final factor = 1 << (steps > 10 ? 10 : steps);
    final wait = hostedAutoLinkBackoffBase * factor;
    _notBefore = now.add(
      wait > hostedAutoLinkBackoffMax ? hostedAutoLinkBackoffMax : wait,
    );
    if (_failures != hostedAutoLinkFailuresBeforeBackoff) return null;
    final reason = describeAttestRequestError(
      HostedAgentException(result.errors.first),
    );
    return "Couldn't link your agents automatically. $reason "
        'Buzz will keep trying, less often.';
  }
}

/// Why a pass may start.
enum HostedAutoLinkTrigger { launch, resume, interval }

/// Decides when passes run: on launch, on resume (at most once a minute)
/// and every 15 minutes while in the foreground; never two at once.
class HostedAutoLinkScheduler {
  HostedAutoLinkScheduler({
    required this.runPass,
    required this.isForeground,
    DateTime Function()? now,
  }) : _now = now ?? DateTime.now;

  final Future<void> Function() runPass;
  final bool Function() isForeground;
  final DateTime Function() _now;

  bool _running = false;
  bool _stopped = false;
  DateTime? _lastStart;

  /// Start a pass for [reason] if one may run now; returns whether it did.
  bool trigger(HostedAutoLinkTrigger reason) {
    if (_stopped || _running || !isForeground()) return false;
    final now = _now();
    final last = _lastStart;
    if (last != null) {
      final since = now.difference(last);
      if (reason == HostedAutoLinkTrigger.resume &&
          since < hostedAutoLinkResumeGap) {
        return false;
      }
      if (reason == HostedAutoLinkTrigger.interval &&
          since < hostedAutoLinkInterval ~/ 2) {
        return false;
      }
    }
    _running = true;
    _lastStart = now;
    unawaited(_run());
    return true;
  }

  Future<void> _run() async {
    try {
      await runPass();
    } on Object {
      // A pass reports its own errors; the next trigger tries again.
    } finally {
      _running = false;
    }
  }

  /// Never start another pass.
  void stop() => _stopped = true;
}

/// The production API for one signed-in client.
class HostedAutoLinkClientApi implements HostedAutoLinkApi {
  HostedAutoLinkClientApi(this._client, this._catalog);

  final HostedAgentClient _client;
  final Future<HostedAgentCatalog> Function() _catalog;

  @override
  Future<List<HostedAgentSnapshot>> list() async =>
      _client.listAgents(catalog: await _catalog());

  @override
  Future<List<HostedAttestOutcome>> attestPending(
    List<HostedAgentSnapshot> agents,
  ) async => _client.attestPending(catalog: await _catalog(), selected: agents);

  @override
  Future<List<HostedRebindOutcome>> rebind(
    List<HostedAgentSnapshot> agents,
  ) async =>
      _client.rebindOwnerKey(catalog: await _catalog(), selected: agents);
}
