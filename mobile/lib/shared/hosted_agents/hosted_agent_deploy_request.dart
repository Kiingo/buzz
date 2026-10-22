import 'dart:convert';

import 'package:flutter/foundation.dart';

import 'canonical_json.dart';
import 'hosted_agent_catalog.dart';
import 'hosted_agent_errors.dart';
import 'hosted_agent_identity.dart';

/// Longest instructions the API stores.
const hostedAgentMaxSystemPromptBytes = 64 * 1024;

/// What the owner chose for one hosted agent. Everything here is public; the
/// agent key lives only in [HostedAgentIdentity].
@immutable
class HostedAgentDraft {
  const HostedAgentDraft({
    required this.displayName,
    required this.systemPrompt,
    required this.providerConfig,
    this.kiingoAgentId,
  });

  final String displayName;
  final String systemPrompt;

  /// The coerced provider configuration (flat scalars).
  final Map<String, Object> providerConfig;

  /// An existing provider agent the owner picked to attach this Buzz
  /// identity to, instead of the provider creating a new agent. `null`
  /// creates a new one.
  final String? kiingoAgentId;
}

final _uuid = RegExp(
  r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
);

/// Where the agent runs and who owns it.
@immutable
class HostedAgentScope {
  const HostedAgentScope({
    required this.communityId,
    required this.relayUrl,
    required this.executionLocation,
    required this.ownerAttestation,
  });

  final String communityId;

  /// Normalized `wss://host[:port]`.
  final String relayUrl;
  final String executionLocation;

  /// Compact NIP-OA tag JSON, from [computeOwnerAttestation].
  final String ownerAttestation;
}

String _configString(Map<String, Object> config, String key) {
  final value = config[key];
  if (value is String && value.trim().isNotEmpty) return value;
  throw HostedAgentException('provider_config_${key}_invalid');
}

void _assertFlatConfig(Map<String, Object> config) {
  if (config.length > 20 ||
      utf8.encode(jsonEncode(config)).length > 65536 ||
      config.values.any((value) => value is Map || value is List)) {
    throw const HostedAgentException('provider_config_invalid');
  }
}

/// Validate the configuration against the verified catalog and build the
/// execution profile, mirroring the desktop provider's
/// `build_execution_profile`.
Map<String, Object> buildHostedExecutionProfile({
  required Map<String, Object> config,
  required HostedAgentCatalog catalog,
  required String executionLocation,
}) {
  _assertFlatConfig(config);
  final harnessId = _configString(config, 'harness');
  final modelMode = _configString(config, 'model_mode');
  final selector = config['model_selector'] is String
      ? (config['model_selector'] as String).trim()
      : '';
  final reasoning = config['reasoning_effort'] is String
      ? config['reasoning_effort'] as String
      : 'auto';
  final serviceTier = config['service_tier'] is String
      ? config['service_tier'] as String
      : 'auto';
  final catalogVersion = config['capability_catalog_version'] is String
      ? config['capability_catalog_version'] as String
      : catalog.catalogVersion;
  final rawRevision = config['profile_revision'];
  final revision = rawRevision is int && rawRevision > 0 ? rawRevision : 1;

  final harness = catalog.harness(harnessId);
  if (harness == null) {
    throw const HostedAgentException('provider_config_harness_unavailable');
  }
  if (modelMode == 'auto') {
    if (selector.isNotEmpty) {
      throw const HostedAgentException(
        'provider_config_automatic_model_selector_invalid',
      );
    }
  } else if (modelMode == 'track' || modelMode == 'version') {
    HostedModel? model;
    for (final candidate in harness.models) {
      if (candidate.id == selector && candidate.selectorKind == modelMode) {
        model = candidate;
      }
    }
    if (model == null) {
      throw const HostedAgentException('provider_config_model_unavailable');
    }
    if (reasoning != 'auto' && !model.reasoningEfforts.contains(reasoning)) {
      throw const HostedAgentException('provider_config_reasoning_unavailable');
    }
    if (serviceTier != 'auto' && !model.serviceTiers.contains(serviceTier)) {
      throw const HostedAgentException(
        'provider_config_service_tier_unavailable',
      );
    }
  } else {
    throw const HostedAgentException('provider_config_model_mode_invalid');
  }

  return {
    'version': 1,
    'execution_location': executionLocation,
    'execution': {
      'version': 2,
      'harness': {'mode': 'specific', 'id': harnessId},
      'model': modelMode == 'auto'
          ? {'mode': 'auto'}
          : {'mode': modelMode, 'id': selector},
      'reasoning': reasoning == 'auto'
          ? {'mode': 'auto'}
          : {'mode': 'specific', 'effort': reasoning},
      'service_tier': serviceTier == 'auto'
          ? {'mode': 'auto'}
          : {'mode': 'specific', 'id': serviceTier},
    },
    'capability_catalog_version': catalogVersion,
    'profile_revision': revision,
  };
}

/// Instructions snapshot: trimmed text, or `null` for none.
Map<String, Object?> buildHostedAgentInstructions(
  String systemPrompt,
  int profileRevision,
) {
  final normalized = systemPrompt.trim();
  if (utf8.encode(normalized).length > hostedAgentMaxSystemPromptBytes) {
    throw const HostedAgentException('agent_system_prompt_too_large');
  }
  return {
    'version': 1,
    'profile_revision': profileRevision,
    'system_prompt': normalized.isEmpty ? null : normalized,
  };
}

/// Owner-only, matching a new desktop-created agent's default audience.
const hostedAgentResponsePolicy = {
  'version': 1,
  'respond_to': 'owner-only',
  'respond_to_allowlist': <String>[],
};

const _capabilityPolicy = {
  'version': 1,
  'assigned_tools': <String>[],
  'assigned_skills': <String>[],
  'managed_compute_capabilities': <String>[],
};

/// The deterministic key that lets the API recognize a replay of the same
/// create (used by rollback to learn whether an uncertain create landed).
String hostedAgentIdempotencyKey({
  required String communityId,
  required String agentPublicKey,
  required int profileRevision,
  required String providerConfigSha256,
  required Map<String, Object?> agentInstructions,
  required String displayName,
}) => stableJsonSha256({
  'identity_envelope_version': hostedIdentityEnvelopeVersion,
  'community_id': communityId,
  'agent_public_key': agentPublicKey,
  'profile_revision': profileRevision,
  'provider_config_sha256': providerConfigSha256,
  'agent_instructions': agentInstructions,
  'display_name': displayName,
  'response_policy': hostedAgentResponsePolicy,
});

/// Build the full `POST /agents` body. A replay with the same identity, draft
/// and scope yields the same idempotency key and payload hash; only the
/// request id and the envelope's ephemeral key and nonce differ.
Future<Map<String, Object?>> buildHostedProvisionRequest({
  required String requestId,
  required HostedAgentIdentity identity,
  required HostedAgentDraft draft,
  required HostedAgentScope scope,
  required HostedAgentCatalog catalog,
}) async {
  final displayName = draft.displayName.trim();
  if (displayName.isEmpty || displayName.length > 256) {
    throw const HostedAgentException('agent_name_invalid');
  }
  final kiingoAgentId = draft.kiingoAgentId?.trim().toLowerCase();
  if (kiingoAgentId != null && !_uuid.hasMatch(kiingoAgentId)) {
    throw const HostedAgentException('kiingo_agent_id_invalid');
  }
  final config = draft.providerConfig;
  final profile = buildHostedExecutionProfile(
    config: config,
    catalog: catalog,
    executionLocation: scope.executionLocation,
  );
  final revision = profile['profile_revision']! as int;
  final instructions = buildHostedAgentInstructions(
    draft.systemPrompt,
    revision,
  );
  final configHash = stableJsonSha256(config);
  final envelope = await sealHostedIdentity(
    plaintext: identity.identityBundle(scope.ownerAttestation),
    keyId: catalog.provisioningKeyId,
    recipientPublicKey: catalog.provisioningPublicKey,
    associatedData: identityAssociatedData(
      communityId: scope.communityId,
      relayUrl: scope.relayUrl,
      agentPublicKey: identity.publicKey,
      providerConfigSha256: configHash,
    ),
  );
  return {
    'contract_version': 1,
    'request_id': requestId,
    'idempotency_key': hostedAgentIdempotencyKey(
      communityId: scope.communityId,
      agentPublicKey: identity.publicKey,
      profileRevision: revision,
      providerConfigSha256: configHash,
      agentInstructions: instructions,
      displayName: displayName,
    ),
    'community_id': scope.communityId,
    'relay_url': scope.relayUrl,
    'agent_public_key': identity.publicKey,
    'display_name': displayName,
    'provider_config': config,
    'owner_attestation': scope.ownerAttestation,
    'identity_envelope': envelope,
    'execution_profile': profile,
    'agent_instructions': instructions,
    'response_policy': hostedAgentResponsePolicy,
    'capability_policy': _capabilityPolicy,
    // Attach to an existing agent the owner owns; the API refuses an agent
    // that already has a Buzz identity (`already_has_buzz_identity`).
    'kiingo_agent_id': ?kiingoAgentId,
  };
}

bool _invisibleRune(int rune) =>
    rune == 0x00ad ||
    rune == 0x061c ||
    rune == 0x180e ||
    (rune >= 0x200b && rune <= 0x200f) ||
    (rune >= 0x202a && rune <= 0x202e) ||
    (rune >= 0x2060 && rune <= 0x206f) ||
    rune == 0xfeff ||
    (rune >= 0xfff0 && rune <= 0xfff8);

/// Why [value] cannot be published as agent text, or `null` when it can.
///
/// Like the desktop, it refuses control characters (except newline and tab
/// in [multiline] fields) and invisible or bidi-override characters, so what
/// the owner reviewed is exactly what the agent receives.
String? hostedAgentTextProblem(
  String value, {
  required String label,
  bool multiline = false,
}) {
  for (final rune in value.runes) {
    final layout = multiline && (rune == 0x0a || rune == 0x09);
    if (!layout && (rune < 0x20 || (rune >= 0x7f && rune < 0xa0))) {
      return '$label contains a control character.';
    }
    if (_invisibleRune(rune)) {
      return '$label contains an invisible character.';
    }
  }
  return null;
}
