import 'package:flutter/foundation.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../relay/relay.dart';
import 'hosted_agent_catalog.dart';
import 'hosted_agent_client.dart';
import 'hosted_agent_create_flow.dart';
import 'hosted_agent_deploy_request.dart';
import 'hosted_agent_errors.dart';
import 'hosted_agent_identity.dart';
import 'hosted_agent_relay_publisher.dart';
import 'hosted_agent_responses.dart';
import 'hosted_agent_store.dart';

/// What a create produced.
@immutable
sealed class HostedCreateOutcome {
  const HostedCreateOutcome();
}

/// The agent exists. [warning] names a non-fatal follow-up that failed (for
/// example, publishing its profile).
final class HostedCreateSucceeded extends HostedCreateOutcome {
  const HostedCreateSucceeded(this.record, {this.warning});

  final HostedAgentRecord record;
  final String? warning;
}

/// No agent was created. [cleanupConfirmed] says whether anything that might
/// have been created remotely is confirmed gone.
final class HostedCreateFailed extends HostedCreateOutcome {
  const HostedCreateFailed(
    this.error, {
    required this.cleanupConfirmed,
    this.cleanupReason,
  });

  final HostedAgentException error;
  final bool cleanupConfirmed;
  final String? cleanupReason;
}

/// State of the create flow: the in-memory cleanup of a failed create whose
/// remote outcome is still unknown, if any.
@immutable
class HostedAgentFlowState {
  const HostedAgentFlowState({this.pendingCleanup, this.pendingReason});

  final PendingHostedCleanup? pendingCleanup;
  final String? pendingReason;
}

/// Orchestrates create (with rollback) and delete for hosted agents.
class HostedAgentController extends Notifier<HostedAgentFlowState> {
  @override
  HostedAgentFlowState build() {
    // A community or identity switch drops any pending cleanup, together
    // with the agent key it held.
    ref.watch(hostedAgentClientProvider);
    return const HostedAgentFlowState();
  }

  HostedAgentClient _client() =>
      ref.read(hostedAgentClientProvider) ??
      (throw const HostedAgentException('hosted_agents_unavailable'));

  HostedAgentRelayPublisher _publisher(HostedAgentClient client) {
    final config = ref.read(relayConfigProvider);
    return HostedAgentRelayPublisher(
      relayHttpUrl: client.route.relayHttpUrl,
      ownerRelay: SignedEventRelay(
        session: ref.read(relaySessionProvider.notifier),
        nsec: config.nsec,
      ),
    );
  }

  /// Retry the pending cleanup. Returns `true` when nothing is left pending.
  Future<bool> retryCleanup() async {
    final pending = state.pendingCleanup;
    if (pending == null) return true;
    final rollback = await rollbackHostedCreate(
      provisioner: _client(),
      pending: pending,
    );
    switch (rollback) {
      case HostedRollbackRemoved():
        state = const HostedAgentFlowState();
        return true;
      case HostedRollbackKept(:final reason, :final pending):
        state = HostedAgentFlowState(
          pendingCleanup: pending,
          pendingReason: reason,
        );
        return false;
    }
  }

  /// Create a hosted agent from a verified [catalog] and a validated draft.
  Future<HostedCreateOutcome> create({
    required HostedAgentCatalog catalog,
    required HostedAgentDraft draft,
    String? harnessLabel,
    String? modelLabel,
  }) async {
    final client = _client();
    // Finish undoing an earlier failed create before creating anything new.
    if (!await retryCleanup()) {
      return HostedCreateFailed(
        const HostedAgentException('cleanup_pending'),
        cleanupConfirmed: false,
        cleanupReason: state.pendingReason,
      );
    }
    final identity = HostedAgentIdentity.generate();
    final HostedAgentScope scope;
    try {
      scope = HostedAgentScope(
        communityId: client.route.communityId,
        relayUrl: client.route.relayUrl,
        executionLocation: client.route.executionLocation,
        ownerAttestation: computeOwnerAttestation(
          ownerSecretHex: client.ownerSecretHex(),
          agentPublicKey: identity.publicKey,
        ),
      );
    } on HostedAgentException catch (error) {
      identity.forget();
      return HostedCreateFailed(error, cleanupConfirmed: true);
    }

    final HostedAgentState created;
    try {
      created = await createHostedAgent(
        provisioner: client,
        identity: identity,
        draft: draft,
        scope: scope,
        catalog: catalog,
      );
    } on HostedCreateFailure catch (failure) {
      switch (failure.rollback) {
        case HostedRollbackRemoved():
          return HostedCreateFailed(failure.error, cleanupConfirmed: true);
        case HostedRollbackKept(:final reason, :final pending):
          state = HostedAgentFlowState(
            pendingCleanup: pending,
            pendingReason: reason,
          );
          return HostedCreateFailed(
            failure.error,
            cleanupConfirmed: false,
            cleanupReason: reason,
          );
      }
    } on HostedAgentException catch (error) {
      // Rejected before anything was sent.
      identity.forget();
      return HostedCreateFailed(error, cleanupConfirmed: true);
    }

    final displayName = draft.displayName.trim();
    final record = HostedAgentRecord(
      pubkey: identity.publicKey,
      providerAgentId: created.providerAgentId,
      displayName: displayName,
      destination: catalog.providerName,
      harness: harnessLabel,
      model: modelLabel,
      observedState: created.observedState,
      createdAt: DateTime.now(),
    );
    await ref.read(hostedAgentStoreProvider.notifier).upsert(record);

    String? warning;
    final publisher = _publisher(client);
    try {
      await publisher.publishAgentProfile(
        identity: identity,
        displayName: displayName,
        ownerAttestation: scope.ownerAttestation,
      );
      await publisher.publishManagedAgent(
        agentPublicKey: identity.publicKey,
        displayName: displayName,
        systemPrompt: draft.systemPrompt,
      );
    } catch (error) {
      debugPrint('[hosted-agents] profile publish failed: $error');
      warning =
          'The agent is running, but its Buzz profile could not be published yet. '
          'Its name may show as a key until it next updates.';
    } finally {
      identity.forget();
    }
    return HostedCreateSucceeded(record, warning: warning);
  }

  /// Delete a phone-created agent through the API, then retire its Buzz
  /// records. Throws [HostedAgentException] when removal is not confirmed;
  /// the record is kept so a retry can finish.
  Future<String?> delete({
    required HostedAgentCatalog catalog,
    required HostedAgentRecord record,
  }) async {
    final client = _client();
    await client.confirmedDelete(
      catalog: catalog,
      providerAgentId: record.providerAgentId,
    );
    await ref.read(hostedAgentStoreProvider.notifier).remove(record.pubkey);
    try {
      await _publisher(client).retireAgent(
        ownerPublicKey: client.ownerPublicKey(),
        agentPublicKey: record.pubkey,
        ownerAttestation: computeOwnerAttestation(
          ownerSecretHex: client.ownerSecretHex(),
          agentPublicKey: record.pubkey,
        ),
      );
    } catch (error) {
      debugPrint('[hosted-agents] retire publish failed: $error');
      return 'The agent was deleted, but Buzz may list it for a little while.';
    }
    return null;
  }
}

final hostedAgentControllerProvider =
    NotifierProvider<HostedAgentController, HostedAgentFlowState>(
      HostedAgentController.new,
    );
