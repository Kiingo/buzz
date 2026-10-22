import 'package:flutter/foundation.dart';

import 'hosted_agent_errors.dart';
import 'hosted_agent_snapshot.dart';
import 'hosted_owner_rebind.dart';

// Owner attestation of agents the hosted provider minted and holds pending
// until their owner vouches for them (`POST /owner/agents/attest-pending`).
// The body is exactly the re-link body (one NIP-OA attestation per agent,
// 1–20 agents); only the proof's `action` and the outcomes differ.

/// Prefix the API puts on its error and reject codes.
const _codePrefix = 'buzz_hosted_';

final _boundedCode = RegExp(r'^[A-Za-z0-9_-]{1,160}$');
final _hex64 = RegExp(r'^[0-9a-f]{64}$');
final _uuid = RegExp(
  r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
);

/// Agents the list reports as pending attestation. Only these are ever sent
/// to attest-pending.
List<HostedAgentSnapshot> pendingHostedAgents(
  Iterable<HostedAgentSnapshot> agents,
) => List.unmodifiable(
  agents.where((agent) => agent.isPendingAttestation && !agent.isDeleted),
);

/// The attest-pending body without its proof.
Map<String, Object?> buildHostedAttestBody({
  required String ownerSecretHex,
  required String requestId,
  required List<HostedAgentSnapshot> selected,
}) {
  if (selected.any((agent) => !agent.isPendingAttestation)) {
    throw const HostedAgentException('attest_selection_invalid');
  }
  return buildHostedRebindBody(
    ownerSecretHex: ownerSecretHex,
    requestId: requestId,
    selected: selected,
    invalidCode: 'attest_selection_invalid',
  );
}

/// What happened to one agent.
enum HostedAttestStatus {
  /// Now active under the owner's key.
  activated,

  /// Was already active.
  alreadyActive,

  /// Not activated; [HostedAttestOutcome.code] says why.
  rejected,
}

/// One agent's result of an attest-pending request.
@immutable
class HostedAttestOutcome {
  const HostedAttestOutcome({
    required this.providerAgentId,
    required this.status,
    this.code,
    this.dmOpened = false,
    this.kiingoAgentId,
  });

  final String providerAgentId;
  final HostedAttestStatus status;

  /// Code without the `buzz_hosted_` prefix: why a rejected agent was not
  /// activated, or a note on an activated one (`dm_open_failed`).
  final String? code;

  /// Whether the provider opened the owner DM as the agent.
  final bool dmOpened;
  final String? kiingoAgentId;

  /// The agent is linked now. The API reports `dm_open_failed` as a note on
  /// an activated agent (it retries the DM itself); a rejected result with
  /// that code is treated the same way.
  bool get linked =>
      status != HostedAttestStatus.rejected || code == 'dm_open_failed';

  /// A new request (fresh id and proof) may succeed.
  bool get retryable => !linked && isRetryableAttestCode(code);

  /// Plain words for the owner.
  String get label => switch (status) {
    _ when linked && code == 'dm_open_failed' =>
      'Linked; its chat with you opens shortly',
    HostedAttestStatus.activated => 'Linked',
    HostedAttestStatus.alreadyActive => 'Already linked',
    HostedAttestStatus.rejected when linked =>
      'Linked; its chat with you opens shortly',
    HostedAttestStatus.rejected => describeAttestRejection(code),
  };
}

/// Reject codes a fresh request may clear.
bool isRetryableAttestCode(String? code) => switch (code) {
  'activate_failed' || 'result_missing' => true,
  _ => false,
};

/// One short sentence for an agent the API did not activate.
String describeAttestRejection(String? code) => switch (code) {
  'endpoint_not_found' => 'This agent no longer exists on the hosted service.',
  'not_pending' => "This agent isn't waiting to be linked any more; refresh.",
  'agent_key_mismatch' =>
    "The agent's key didn't match; refresh the list and try again.",
  'owner_attestation_invalid' =>
    "The hosted service didn't accept your approval for this agent.",
  'not_agent_owner' => "Only this agent's owner can link it.",
  'identity_unreadable' =>
    "The agent's identity couldn't be read; contact support.",
  'activate_failed' => "Linking didn't finish; retry.",
  'result_missing' => 'The hosted service did not report this agent; retry.',
  _ => "This agent couldn't be linked.",
};

String? _stripPrefix(Object? value) {
  if (value is! String || !_boundedCode.hasMatch(value)) return null;
  return value.startsWith(_codePrefix)
      ? value.substring(_codePrefix.length)
      : value;
}

/// One sentence for a failure of a whole attest request.
String describeAttestRequestError(HostedAgentException error) =>
    switch (_stripPrefix(error.code)) {
      'attest_pending_invalid' || 'attest_selection_invalid' =>
        "The link request wasn't accepted; update Buzz and try again.",
      _ => describeRebindRequestError(error),
    };

/// Parse an attest-pending answer to [requestId] for [requested], signed by
/// [ownerPublicKey]. Every requested agent gets exactly one outcome: one the
/// API did not report is a retryable `result_missing`; a result for an agent
/// that was not requested, a second one, or an unknown outcome makes the
/// answer invalid.
List<HostedAttestOutcome> parseHostedAttestResponse(
  Object? body, {
  required String requestId,
  required String ownerPublicKey,
  required List<HostedAgentSnapshot> requested,
}) {
  if (body is! Map ||
      body['contract_version'] != 1 ||
      body['correlation_id'] != requestId ||
      body['owner_public_key'] is! String ||
      (body['owner_public_key'] as String).toLowerCase() !=
          ownerPublicKey.toLowerCase() ||
      body['results'] is! List) {
    throw const HostedAgentException('response_invalid');
  }
  final wanted = {
    for (final agent in requested) agent.providerAgentId: agent.agentPublicKey,
  };
  final byId = <String, HostedAttestOutcome>{};
  for (final raw in body['results'] as List) {
    if (raw is! Map) throw const HostedAgentException('response_invalid');
    final id = raw['provider_agent_id'];
    final key = raw['agent_public_key'];
    if (id is! String ||
        !wanted.containsKey(id) ||
        byId.containsKey(id) ||
        key is! String ||
        !_hex64.hasMatch(key.toLowerCase()) ||
        key.toLowerCase() != wanted[id]) {
      throw const HostedAgentException('response_invalid');
    }
    final status = switch (raw['outcome']) {
      'activated' => HostedAttestStatus.activated,
      'already_active' => HostedAttestStatus.alreadyActive,
      'rejected' => HostedAttestStatus.rejected,
      _ => throw const HostedAgentException('response_invalid'),
    };
    final kiingoAgentId = raw['kiingo_agent_id'];
    byId[id] = HostedAttestOutcome(
      providerAgentId: id,
      status: status,
      code: status == HostedAttestStatus.rejected
          ? (_stripPrefix(raw['code']) ?? 'activate_failed')
          : _stripPrefix(raw['code']),
      dmOpened: raw['dm_opened'] == true,
      kiingoAgentId:
          kiingoAgentId is String && _uuid.hasMatch(kiingoAgentId.toLowerCase())
          ? kiingoAgentId.toLowerCase()
          : null,
    );
  }
  return List.unmodifiable([
    for (final agent in requested)
      byId[agent.providerAgentId] ??
          HostedAttestOutcome(
            providerAgentId: agent.providerAgentId,
            status: HostedAttestStatus.rejected,
            code: 'result_missing',
          ),
  ]);
}
