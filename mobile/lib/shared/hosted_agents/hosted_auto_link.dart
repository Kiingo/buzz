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
// authenticated list returned are ever signed for.

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

/// The result of one pass.
@immutable
class HostedAutoLinkResult {
  const HostedAutoLinkResult({
    this.linked = const [],
    this.errors = const [],
    this.sent = false,
  });

  /// Names of agents this pass attested or re-linked, in list order.
  final List<String> linked;

  /// Whole-request error codes, if a request failed.
  final List<String> errors;

  /// Whether the pass sent any request after listing.
  final bool sent;
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
/// next pass starts over from a fresh list.
Future<HostedAutoLinkResult> runHostedAutoLinkPass({
  required HostedAutoLinkApi api,
  required String ownerPublicKey,
  required HostedAutoLinkMemory memory,
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
  final errors = <String>[];
  var sent = false;
  try {
    for (final batch in _chunk(pending, hostedRebindMaxAgents)) {
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
          memory.refused.add(HostedAutoLinkMemory.keyFor(owner, agent));
        }
      }
    }
    for (final batch in _chunk(stale, hostedRebindMaxAgents)) {
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
          memory.refused.add(HostedAutoLinkMemory.keyFor(owner, agent));
        }
      }
    }
  } on HostedAgentException catch (error) {
    errors.add(error.code);
  }
  return HostedAutoLinkResult(
    linked: List.unmodifiable([
      for (final agent in agents)
        if (linked.contains(agent.providerAgentId))
          agent.displayName.trim().isEmpty
              ? 'an agent'
              : agent.displayName.trim(),
    ]),
    errors: List.unmodifiable(errors),
    sent: sent,
  );
}

/// The quiet note after a pass, or `null` when it linked nothing.
String? hostedAutoLinkNote(List<String> names) {
  if (names.isEmpty) return null;
  if (names.length <= 4) return 'Linked: ${names.join(', ')}';
  return 'Linked: ${names.take(3).join(', ')} and ${names.length - 3} more';
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
