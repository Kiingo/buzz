import 'package:flutter/foundation.dart';

import 'canonical_json.dart';
import 'hosted_agent_errors.dart';
import 'hosted_agent_identity.dart';
import 'hosted_agent_snapshot.dart';

/// Most agents one re-link request may name.
const hostedRebindMaxAgents = 20;

/// Prefix the API puts on its error and reject codes.
const _codePrefix = 'buzz_hosted_';

final _boundedCode = RegExp(r'^[A-Za-z0-9_-]{1,160}$');
final _hex64 = RegExp(r'^[0-9a-f]{64}$');

/// Agents still linked to an earlier owner key: the API names an owner key
/// and it is not [currentOwnerPublicKey]. An agent whose owner key the API
/// did not report (`null`) is not offered, and neither is a deleted one.
List<HostedAgentSnapshot> staleHostedAgents(
  Iterable<HostedAgentSnapshot> agents,
  String currentOwnerPublicKey,
) {
  final current = currentOwnerPublicKey.toLowerCase();
  return List.unmodifiable(
    agents.where((agent) {
      final owner = agent.ownerPublicKey;
      return owner != null && owner != current && !agent.isDeleted;
    }),
  );
}

/// Agents the API already holds under [currentOwnerPublicKey].
List<HostedAgentSnapshot> currentHostedAgents(
  Iterable<HostedAgentSnapshot> agents,
  String currentOwnerPublicKey,
) {
  final current = currentOwnerPublicKey.toLowerCase();
  return List.unmodifiable(
    agents.where(
      (agent) => agent.ownerPublicKey == current && !agent.isDeleted,
    ),
  );
}

/// The re-link body without its proof: one fresh request id and a NIP-OA
/// owner attestation from the current key for each selected agent, and for
/// no other agent.
Map<String, Object?> buildHostedRebindBody({
  required String ownerSecretHex,
  required String requestId,
  required List<HostedAgentSnapshot> selected,
}) {
  if (selected.isEmpty || selected.length > hostedRebindMaxAgents) {
    throw const HostedAgentException('rebind_selection_invalid');
  }
  final seen = <String>{};
  for (final agent in selected) {
    if (!seen.add(agent.providerAgentId)) {
      throw const HostedAgentException('rebind_selection_invalid');
    }
  }
  return {
    'contract_version': 1,
    'request_id': requestId,
    'agents': [
      for (final agent in selected)
        {
          'provider_agent_id': agent.providerAgentId,
          'agent_public_key': agent.agentPublicKey,
          'owner_attestation': computeOwnerAttestation(
            ownerSecretHex: ownerSecretHex,
            agentPublicKey: agent.agentPublicKey,
          ),
        },
    ],
  };
}

/// SHA-256 bound into the proof's `payload` tag.
String hostedRebindPayloadSha256(Map<String, Object?> body) =>
    stableJsonSha256(body);

/// What happened to one agent.
enum HostedRebindStatus {
  /// Now linked to the current key.
  rebound,

  /// Was already linked to the current key.
  alreadyCurrent,

  /// Not re-linked; [HostedRebindOutcome.code] says why.
  rejected,
}

/// One agent's result of a re-link request.
@immutable
class HostedRebindOutcome {
  const HostedRebindOutcome({
    required this.providerAgentId,
    required this.status,
    this.code,
  });

  final String providerAgentId;
  final HostedRebindStatus status;

  /// Reject code without the `buzz_hosted_` prefix, for [HostedRebindStatus.rejected].
  final String? code;

  /// A new request (fresh id and proof) may succeed.
  bool get retryable =>
      status == HostedRebindStatus.rejected && isRetryableRebindCode(code);

  /// Plain words for the owner.
  String get label => switch (status) {
    HostedRebindStatus.rebound => 'Re-linked',
    HostedRebindStatus.alreadyCurrent => 'Already linked',
    HostedRebindStatus.rejected => describeRebindRejection(code),
  };
}

String? _stripPrefix(Object? value) {
  if (value is! String || !_boundedCode.hasMatch(value)) return null;
  return value.startsWith(_codePrefix)
      ? value.substring(_codePrefix.length)
      : value;
}

/// Reject codes a fresh request may clear.
bool isRetryableRebindCode(String? code) => switch (code) {
  'profile_revision_conflict' || 'rebind_failed' || 'result_missing' => true,
  _ => false,
};

/// One short sentence for an agent the API did not re-link.
String describeRebindRejection(String? code) => switch (code) {
  'endpoint_not_found' => 'This agent no longer exists on the hosted service.',
  'agent_key_mismatch' =>
    "The agent's key didn't match; refresh the list and try again.",
  'owner_attestation_invalid' =>
    "The hosted service didn't accept your approval for this agent.",
  'previous_owner_not_revoked' =>
    'Your old key is still active, so this agent stays linked to it.',
  'identity_unreadable' =>
    "The agent's identity couldn't be read; contact support.",
  'rotation_in_progress' =>
    'A key change is still in progress; finish it, then try again.',
  'profile_revision_conflict' =>
    'The agent changed while it was being re-linked; retry.',
  'rebind_failed' => "Re-linking didn't finish; retry.",
  'result_missing' => 'The hosted service did not report this agent; retry.',
  _ => "This agent couldn't be re-linked.",
};

/// One sentence for a failure of the whole request.
String describeRebindRequestError(
  HostedAgentException error,
) => switch (_stripPrefix(error.code)) {
  'rebind_invalid' || 'rebind_selection_invalid' =>
    "The re-link request wasn't accepted; update Buzz and try again.",
  'owner_proof_invalid' =>
    "Your signature wasn't accepted; check this device's date and time, then try again.",
  'owner_proof_replayed' => 'That request was already used; try again.',
  'owner_not_linked' =>
    "Your current key isn't linked to your account yet; link it, then try again.",
  'owner_ambiguous' =>
    'More than one account matches your key; contact support.',
  'scope_unconfigured' => "Re-linking isn't available for this community yet.",
  'provisioning_keys_unconfigured' || 'provisioning_keys_invalid' =>
    "The hosted service can't re-link agents right now; try again later.",
  'database_unavailable' =>
    'The hosted service is temporarily unavailable; try again in a moment.',
  _ => error.message,
};

/// Parse a re-link answer to the request [requestId] for [requested] agents
/// signed by [ownerPublicKey]. Every requested agent gets exactly one
/// outcome: one the API did not report is a retryable `result_missing`, and
/// a result for an agent that was not requested makes the answer invalid.
List<HostedRebindOutcome> parseHostedRebindResponse(
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
  final byId = <String, HostedRebindOutcome>{};
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
      'rebound' => HostedRebindStatus.rebound,
      'already_current' => HostedRebindStatus.alreadyCurrent,
      'rejected' => HostedRebindStatus.rejected,
      _ => throw const HostedAgentException('response_invalid'),
    };
    byId[id] = HostedRebindOutcome(
      providerAgentId: id,
      status: status,
      code: status == HostedRebindStatus.rejected
          ? (_stripPrefix(raw['code']) ?? 'rebind_failed')
          : null,
    );
  }
  return List.unmodifiable([
    for (final agent in requested)
      byId[agent.providerAgentId] ??
          HostedRebindOutcome(
            providerAgentId: agent.providerAgentId,
            status: HostedRebindStatus.rejected,
            code: 'result_missing',
          ),
  ]);
}
