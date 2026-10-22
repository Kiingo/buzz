import 'package:flutter/foundation.dart';

import 'hosted_agent_catalog.dart';
import 'hosted_agent_errors.dart';

/// One hosted agent as the API reports it now (`BuzzHostedAgentStateResponse`).
@immutable
class HostedAgentSnapshot {
  const HostedAgentSnapshot({
    required this.providerAgentId,
    required this.agentPublicKey,
    required this.displayName,
    required this.providerConfig,
    required this.profileRevision,
    required this.desiredState,
    required this.observedState,
    this.systemPrompt,
    this.lastReadyAt,
    this.errorCode,
    this.ownerPublicKey,
    this.status = hostedAgentStatusActive,
    this.kiingoAgentId,
  });

  final String providerAgentId;

  /// Lowercase hex Buzz public key.
  final String agentPublicKey;
  final String displayName;

  /// Flat execution-profile choices (`harness`, `model_mode`, ...).
  final Map<String, Object?> providerConfig;
  final String? systemPrompt;

  /// Revision every update and control must name (optimistic concurrency).
  final int profileRevision;

  /// `active`, `paused` or `deleted`.
  final String desiredState;

  /// `provisioning`, `ready`, `updating`, `paused`, `action_required`,
  /// `degraded`, `deletion_pending` or `deleted`.
  final String observedState;
  final DateTime? lastReadyAt;
  final String? errorCode;

  /// Lowercase hex owner key the API holds for this agent, or `null` when the
  /// API did not say. A value other than the signed-in key means the agent is
  /// still linked to an earlier owner key.
  final String? ownerPublicKey;

  /// [hostedAgentStatusActive], [hostedAgentStatusPendingAttestation], or
  /// `unknown` for any other value. Older APIs leave it out (active).
  final String status;

  /// The provider's own id for the agent (lowercase UUID), when reported.
  final String? kiingoAgentId;

  /// The provider minted this agent and holds it until its owner attests it.
  bool get isPendingAttestation =>
      status == hostedAgentStatusPendingAttestation;

  /// A live agent the owner can manage.
  bool get isActive => status == hostedAgentStatusActive;

  bool get isDeleted =>
      desiredState == 'deleted' ||
      observedState == 'deleted' ||
      observedState == 'deletion_pending';

  bool get isPaused => desiredState == 'paused';

  String? get harness => providerConfig['harness'] is String
      ? providerConfig['harness'] as String
      : null;

  /// The configuration as form values, for editing.
  Map<String, String> get formConfig => {
    for (final entry in providerConfig.entries)
      if (entry.value is String || entry.value is num || entry.value is bool)
        entry.key: '${entry.value}',
  };
}

/// `status` of a live hosted agent.
const hostedAgentStatusActive = 'active';

/// `status` of an agent the provider holds until its owner attests it.
const hostedAgentStatusPendingAttestation = 'pending_attestation';

final _word = RegExp(r'^[a-z_]{1,40}$');
final _uuid = RegExp(
  r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
);
final _hex64 = RegExp(r'^[0-9a-f]{64}$');
final _code = RegExp(r'^[A-Za-z0-9_-]{1,160}$');

String? _optionalString(Object? value) =>
    value is String && value.trim().isNotEmpty ? value : null;

String _status(Object? value) => switch (value) {
  null => hostedAgentStatusActive,
  hostedAgentStatusActive => hostedAgentStatusActive,
  hostedAgentStatusPendingAttestation => hostedAgentStatusPendingAttestation,
  _ => 'unknown',
};

/// Parse one state object, or `null` when it is malformed.
///
/// A pending agent has no running state or profile yet, so for it only the
/// id, key and name are required; its revision reads as 0 and its states as
/// `pending_attestation` when the API leaves them out.
HostedAgentSnapshot? parseHostedAgentSnapshot(Object? value) {
  if (value is! Map) return null;
  final id = value['provider_agent_id'];
  final pubkey = value['agent_public_key'];
  final name = value['display_name'];
  final status = _status(value['status']);
  final pendingAgent = status == hostedAgentStatusPendingAttestation;
  final rawDesired = value['desired_state'];
  final rawObserved = value['observed_state'];
  final desired = rawDesired is String && _word.hasMatch(rawDesired)
      ? rawDesired
      : (pendingAgent ? hostedAgentStatusPendingAttestation : null);
  final observed = rawObserved is String && _word.hasMatch(rawObserved)
      ? rawObserved
      : (pendingAgent ? hostedAgentStatusPendingAttestation : null);
  if (id is! String ||
      id.trim().isEmpty ||
      id.length > 256 ||
      pubkey is! String ||
      !_hex64.hasMatch(pubkey.toLowerCase()) ||
      name is! String ||
      desired == null ||
      observed == null) {
    return null;
  }
  final profile = value['profile'];
  final instructions = value['agent_instructions'];
  final rawRevision = profile is Map
      ? profile['profile_revision']
      : (instructions is Map ? instructions['profile_revision'] : null);
  final revisionValue = rawRevision is int && rawRevision >= 1
      ? rawRevision
      : (pendingAgent ? 0 : null);
  if (revisionValue == null) return null;
  final config = value['provider_config'];
  final errorCode = value['error_code'];
  final owner = value['owner_public_key'];
  return HostedAgentSnapshot(
    providerAgentId: id,
    agentPublicKey: pubkey.toLowerCase(),
    displayName: name,
    providerConfig: config is Map
        ? Map<String, Object?>.unmodifiable({
            for (final entry in config.entries)
              if (entry.value is! Map && entry.value is! List)
                entry.key.toString(): entry.value,
          })
        : const {},
    systemPrompt: instructions is Map
        ? _optionalString(instructions['system_prompt'])
        : null,
    profileRevision: revisionValue,
    desiredState: desired,
    observedState: observed,
    lastReadyAt: DateTime.tryParse(
      _optionalString(value['last_ready_at']) ?? '',
    ),
    errorCode: errorCode is String && _code.hasMatch(errorCode)
        ? errorCode
        : null,
    ownerPublicKey: owner is String && _hex64.hasMatch(owner.toLowerCase())
        ? owner.toLowerCase()
        : null,
    status: status,
    kiingoAgentId: _kiingoAgentId(value['kiingo_agent_id']),
  );
}

String? _kiingoAgentId(Object? value) {
  if (value is! String) return null;
  final id = value.toLowerCase();
  return _uuid.hasMatch(id) ? id : null;
}

/// Parse a list response; it must answer this request.
List<HostedAgentSnapshot> parseHostedAgentList(Object? body, String requestId) {
  if (body is! Map ||
      body['contract_version'] != 1 ||
      body['correlation_id'] != requestId ||
      body['agents'] is! List) {
    throw const HostedAgentException('response_invalid');
  }
  return List.unmodifiable(
    (body['agents'] as List)
        .map(parseHostedAgentSnapshot)
        .whereType<HostedAgentSnapshot>(),
  );
}

/// Parse an update or control response for [providerAgentId].
HostedAgentSnapshot parseHostedAgentWrite(
  Object? body, {
  required String providerAgentId,
}) {
  final snapshot = parseHostedAgentSnapshot(body);
  if (snapshot == null || snapshot.providerAgentId != providerAgentId) {
    throw const HostedAgentException('response_invalid');
  }
  return snapshot;
}

/// Plain labels for an agent's harness and model, using the catalog's names
/// when it lists them.
({String? harness, String? model}) hostedProfileLabels(
  HostedAgentCatalog? catalog,
  Map<String, Object?> config,
) {
  final harnessId = config['harness'] is String
      ? config['harness'] as String
      : null;
  final harness = harnessId == null ? null : catalog?.harness(harnessId);
  final labels = catalog?.configSchema['properties'];
  final harnessProperty = labels is Map ? labels['harness'] : null;
  final enumLabels = harnessProperty is Map
      ? harnessProperty['x-enum-labels']
      : null;
  final harnessLabel = enumLabels is Map && enumLabels[harnessId] is String
      ? enumLabels[harnessId] as String
      : harness?.displayName ?? harnessId;
  final mode = config['model_mode'];
  final selector = config['model_selector'];
  String? modelLabel;
  if (mode == 'auto' || mode == null) {
    modelLabel = 'Default model';
  } else if (selector is String && selector.isNotEmpty) {
    modelLabel = selector;
    for (final model in harness?.models ?? const <HostedModel>[]) {
      if (model.id == selector) modelLabel = model.displayName;
    }
  }
  return (harness: harnessLabel, model: modelLabel);
}
