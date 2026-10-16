import 'package:flutter/foundation.dart';
import 'package:uuid/uuid.dart';

import 'hosted_agent_catalog.dart';
import 'hosted_agent_deploy_request.dart';
import 'hosted_agent_errors.dart';
import 'hosted_agent_identity.dart';
import 'hosted_agent_responses.dart';

/// The two API calls create and rollback need.
abstract interface class HostedAgentProvisioner {
  Future<HostedAgentState> provision(Map<String, Object?> request);

  Future<void> confirmedDelete({
    required HostedAgentCatalog catalog,
    required String providerAgentId,
  });
}

/// Everything needed to finish undoing a create whose outcome is unknown.
/// It holds the in-memory agent key so the identical create can be replayed;
/// it is never persisted.
class PendingHostedCleanup {
  PendingHostedCleanup({
    required this.identity,
    required this.draft,
    required this.scope,
    required this.catalog,
    this.providerAgentId,
  });

  final HostedAgentIdentity identity;
  final HostedAgentDraft draft;
  final HostedAgentScope scope;
  final HostedAgentCatalog catalog;

  /// Known once a replay (or the original create) returned it.
  String? providerAgentId;
}

/// The result of undoing a failed create.
@immutable
sealed class HostedRollback {
  const HostedRollback();
}

/// Nothing from this create remains on the API.
final class HostedRollbackRemoved extends HostedRollback {
  const HostedRollbackRemoved();
}

/// Removal could not be confirmed; [pending] can be retried safely.
final class HostedRollbackKept extends HostedRollback {
  const HostedRollbackKept(this.reason, this.pending);

  final String reason;
  final PendingHostedCleanup pending;
}

/// A create that did not produce a running agent, plus what rollback did.
class HostedCreateFailure implements Exception {
  const HostedCreateFailure(this.error, this.rollback);

  final HostedAgentException error;
  final HostedRollback rollback;

  @override
  String toString() => 'HostedCreateFailure(${error.code})';
}

/// Create one hosted agent. On any failure after the request may have reached
/// the API, undo it before returning (see [rollbackHostedCreate]).
///
/// Validation failures before anything is sent throw a plain
/// [HostedAgentException]: nothing was created.
Future<HostedAgentState> createHostedAgent({
  required HostedAgentProvisioner provisioner,
  required HostedAgentIdentity identity,
  required HostedAgentDraft draft,
  required HostedAgentScope scope,
  required HostedAgentCatalog catalog,
  String Function()? newRequestId,
}) async {
  final requestId = newRequestId ?? () => const Uuid().v4();
  final request = await buildHostedProvisionRequest(
    requestId: requestId(),
    identity: identity,
    draft: draft,
    scope: scope,
    catalog: catalog,
  );
  try {
    return await provisioner.provision(request);
  } on HostedAgentException catch (error) {
    final pending = PendingHostedCleanup(
      identity: identity,
      draft: draft,
      scope: scope,
      catalog: catalog,
    );
    if (error.remoteAbsent) identity.forget();
    final rollback = error.remoteAbsent
        ? const HostedRollbackRemoved()
        : await rollbackHostedCreate(
            provisioner: provisioner,
            pending: pending,
            newRequestId: requestId,
          );
    throw HostedCreateFailure(error, rollback);
  }
}

/// Undo a create that did not start. Idempotent, and it never treats "the
/// phone forgot about it" as proof the remote agent is gone:
///
/// 1. With a known agent id, confirmed delete removes it.
/// 2. Otherwise the outcome is unknown, so the identical create is replayed
///    once. The API's replay-first idempotency returns the existing agent (or
///    creates it now), which is then deleted; a rejection carrying
///    `agent_state: "absent"` proves nothing exists.
/// 3. Any other failure keeps [pending] so a retry can finish.
Future<HostedRollback> rollbackHostedCreate({
  required HostedAgentProvisioner provisioner,
  required PendingHostedCleanup pending,
  String Function()? newRequestId,
}) async {
  final requestId = newRequestId ?? () => const Uuid().v4();
  if (pending.providerAgentId == null) {
    try {
      final replay = await provisioner.provision(
        await buildHostedProvisionRequest(
          requestId: requestId(),
          identity: pending.identity,
          draft: pending.draft,
          scope: pending.scope,
          catalog: pending.catalog,
        ),
      );
      pending.providerAgentId = replay.providerAgentId;
    } on HostedAgentException catch (error) {
      if (error.remoteAbsent) {
        pending.identity.forget();
        return const HostedRollbackRemoved();
      }
      return HostedRollbackKept(
        "Couldn't confirm whether the agent exists: ${error.message}",
        pending,
      );
    }
  }
  try {
    await provisioner.confirmedDelete(
      catalog: pending.catalog,
      providerAgentId: pending.providerAgentId!,
    );
  } on HostedAgentException catch (error) {
    return HostedRollbackKept(
      "Couldn't remove the agent: ${error.message}",
      pending,
    );
  }
  pending.identity.forget();
  return const HostedRollbackRemoved();
}
