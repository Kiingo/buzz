import 'package:hooks_riverpod/hooks_riverpod.dart';

import 'hosted_agent_client.dart';
import 'hosted_agent_controller.dart';
import 'hosted_agent_errors.dart';
import 'hosted_agent_snapshot.dart';
import 'hosted_owner_rebind.dart';

/// Lifecycle actions the phone offers.
enum HostedAgentAction {
  /// Re-read the agent's state.
  status('status'),

  /// Stop answering until resumed (desired state `paused`).
  pause('pause'),

  /// Start again (desired state `active`).
  resume('resume'),

  /// Re-apply the desired state when the agent is stuck.
  reconcile('reconcile');

  const HostedAgentAction(this.wire);

  final String wire;
}

/// Every hosted agent the owner has, with live state from the API,
/// including agents created on desktop.
class HostedAgentList extends AsyncNotifier<List<HostedAgentSnapshot>> {
  @override
  Future<List<HostedAgentSnapshot>> build() async {
    final client = ref.watch(hostedAgentClientProvider);
    if (client == null) return const [];
    final catalog = await ref.watch(hostedAgentCatalogProvider.future);
    return client.listAgents(catalog: catalog);
  }

  HostedAgentClient _client() =>
      ref.read(hostedAgentClientProvider) ??
      (throw const HostedAgentException('hosted_agents_unavailable'));

  /// Re-list from the API, keeping the current list visible meanwhile.
  Future<void> refresh() async {
    final client = _client();
    final catalog = await ref.read(hostedAgentCatalogProvider.future);
    state = await AsyncValue.guard(() => client.listAgents(catalog: catalog));
  }

  void _replace(HostedAgentSnapshot snapshot) {
    final current = state.value;
    if (current == null) return;
    state = AsyncData([
      for (final agent in current)
        agent.providerAgentId == snapshot.providerAgentId ? snapshot : agent,
    ]);
  }

  Future<HostedAgentSnapshot?> _latest(String providerAgentId) async {
    await refresh();
    for (final agent in state.value ?? const <HostedAgentSnapshot>[]) {
      if (agent.providerAgentId == providerAgentId) return agent;
    }
    return null;
  }

  /// Run [action]. A lifecycle action does not depend on the profile, so a
  /// revision conflict (someone edited the agent meanwhile) refreshes and
  /// retries once against the newest revision.
  Future<HostedAgentSnapshot> control(
    HostedAgentSnapshot agent,
    HostedAgentAction action,
  ) async {
    final client = _client();
    final catalog = await ref.read(hostedAgentCatalogProvider.future);
    HostedAgentSnapshot result;
    try {
      result = await client.controlAgent(
        catalog: catalog,
        providerAgentId: agent.providerAgentId,
        expectedRevision: agent.profileRevision,
        action: action.wire,
      );
    } on HostedAgentException catch (error) {
      if (!isHostedRevisionConflict(error)) rethrow;
      final latest = await _latest(agent.providerAgentId);
      if (latest == null) {
        throw const HostedAgentException('buzz_hosted_endpoint_not_found');
      }
      result = await client.controlAgent(
        catalog: catalog,
        providerAgentId: latest.providerAgentId,
        expectedRevision: latest.profileRevision,
        action: action.wire,
      );
    }
    _replace(result);
    return result;
  }

  /// Save an edit made against [expectedRevision]. A revision conflict is not
  /// retried: the list refreshes and the error is rethrown so the owner can
  /// review the newer settings before saving again.
  Future<HostedAgentSnapshot> saveEdit({
    required HostedAgentSnapshot agent,
    required int expectedRevision,
    required String displayName,
    required String? systemPrompt,
    required Map<String, Object> providerConfig,
    String? harnessLabel,
    String? modelLabel,
  }) async {
    final client = _client();
    final catalog = await ref.read(hostedAgentCatalogProvider.future);
    final HostedAgentSnapshot result;
    try {
      result = await client.updateAgent(
        catalog: catalog,
        providerAgentId: agent.providerAgentId,
        expectedRevision: expectedRevision,
        displayName: displayName,
        providerConfig: providerConfig,
        systemPrompt: systemPrompt,
      );
    } on HostedAgentException catch (error) {
      if (isHostedRevisionConflict(error)) await refresh();
      rethrow;
    }
    _replace(result);
    await ref
        .read(hostedAgentControllerProvider.notifier)
        .syncEditedAgent(
          result,
          harnessLabel: harnessLabel,
          modelLabel: modelLabel,
        );
    return result;
  }

  /// Delete [agent] with the API's confirmed delete. Returns a non-fatal
  /// follow-up warning, if any.
  Future<String?> delete(HostedAgentSnapshot agent) async {
    final catalog = await ref.read(hostedAgentCatalogProvider.future);
    final warning = await ref
        .read(hostedAgentControllerProvider.notifier)
        .delete(
          catalog: catalog,
          providerAgentId: agent.providerAgentId,
          agentPublicKey: agent.agentPublicKey,
        );
    final current = state.value;
    if (current != null) {
      state = AsyncData([
        for (final candidate in current)
          if (candidate.providerAgentId != agent.providerAgentId) candidate,
      ]);
    }
    return warning;
  }

  /// The signed-in owner key, or `null` when this device can't sign.
  String? currentOwnerPublicKey() {
    try {
      return ref.read(hostedAgentClientProvider)?.ownerPublicKey();
    } on HostedAgentException {
      return null;
    }
  }

  /// Re-link [selected] to the signed-in key, then refresh the list so each
  /// agent shows the owner key the API now holds. Only the owner's confirm
  /// tap calls this.
  Future<List<HostedRebindOutcome>> rebindOwnerKey(
    List<HostedAgentSnapshot> selected,
  ) async {
    final client = _client();
    final catalog = await ref.read(hostedAgentCatalogProvider.future);
    final outcomes = await client.rebindOwnerKey(
      catalog: catalog,
      selected: selected,
    );
    try {
      await refresh();
    } on Object {
      // The re-link already happened; a failed re-list keeps the previous
      // list and the owner can pull to refresh. Never report it as a failed
      // re-link.
    }
    return outcomes;
  }

  /// The newest snapshot for [providerAgentId] in the current list.
  HostedAgentSnapshot? find(String providerAgentId) {
    for (final agent in state.value ?? const <HostedAgentSnapshot>[]) {
      if (agent.providerAgentId == providerAgentId) return agent;
    }
    return null;
  }
}

final hostedAgentListProvider =
    AsyncNotifierProvider<HostedAgentList, List<HostedAgentSnapshot>>(
      HostedAgentList.new,
    );
