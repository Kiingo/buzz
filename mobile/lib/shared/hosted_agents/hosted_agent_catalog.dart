import 'dart:convert';

import 'package:cryptography/cryptography.dart';
import 'package:flutter/foundation.dart';

import 'canonical_json.dart';
import 'hosted_agent_errors.dart';

/// Longest lifetime a signed catalog may claim.
const _catalogMaxLifetimeSeconds = 31 * 24 * 60 * 60;

/// Clock skew allowed for a catalog issued "in the future".
const _catalogClockSkewSeconds = 5 * 60;

/// One model a harness advertises.
@immutable
class HostedModel {
  const HostedModel({
    required this.id,
    required this.displayName,
    required this.selectorKind,
    required this.reasoningEfforts,
    required this.serviceTiers,
    this.description,
    this.isDefault = false,
  });

  final String id;
  final String displayName;
  final String? description;
  final bool isDefault;

  /// `track` (a model family that resolves to its newest version at deploy)
  /// or `version` (one exact model).
  final String selectorKind;
  final List<String> reasoningEfforts;
  final List<String> serviceTiers;
}

/// One harness (agent runtime) the hosted destination offers.
@immutable
class HostedHarness {
  const HostedHarness({
    required this.id,
    required this.displayName,
    required this.models,
  });

  final String id;
  final String displayName;
  final List<HostedModel> models;
}

/// The API's verified capability catalog.
@immutable
class HostedAgentCatalog {
  const HostedAgentCatalog({
    required this.providerId,
    required this.providerName,
    required this.apiBaseUrl,
    required this.provisioningKeyId,
    required this.provisioningPublicKey,
    required this.catalogVersion,
    required this.configSchema,
    required this.harnesses,
  });

  /// Provider id bound into owner proofs.
  final String providerId;

  /// Destination name shown under "Where it runs".
  final String providerName;
  final String apiBaseUrl;
  final String provisioningKeyId;

  /// X25519 key the agent identity bundle is encrypted to.
  final Uint8List provisioningPublicKey;
  final String catalogVersion;

  /// JSON schema for the execution-profile fields (harness, model, ...).
  final Map<String, Object?> configSchema;
  final List<HostedHarness> harnesses;

  HostedHarness? harness(String id) {
    for (final harness in harnesses) {
      if (harness.id == id) return harness;
    }
    return null;
  }
}

Never _invalid(String code) => throw HostedAgentException(code);

String _string(Object? value, String code) {
  if (value is String && value.trim().isNotEmpty) return value.trim();
  return _invalid(code);
}

List<String> _strings(Object? value) => value is List
    ? value.whereType<String>().toList(growable: false)
    : const <String>[];

/// Check the catalog's validity window against [nowEpochSeconds].
@visibleForTesting
void validateCatalogWindow(Map<Object?, Object?> value, int nowEpochSeconds) {
  final issued = value['issued_at_epoch_seconds'];
  final expires = value['expires_at_epoch_seconds'];
  if (issued is! int || expires is! int) {
    _invalid('capability_window_invalid');
  }
  if (issued > nowEpochSeconds + _catalogClockSkewSeconds ||
      expires <= nowEpochSeconds ||
      expires <= issued ||
      expires - issued > _catalogMaxLifetimeSeconds) {
    _invalid('capability_window_invalid');
  }
}

/// Verify the API's signed capability catalog the way the desktop's bundled
/// provider does, then parse it.
///
/// The signature must come from [pinnedPublicKey] (a server response cannot
/// replace the trust anchor), cover the canonical JSON of every field except
/// `signature`, and match `payload_sha256`. The catalog must name
/// [expectedApiBaseUrl] and still be inside its validity window.
Future<HostedAgentCatalog> verifyHostedAgentCatalog(
  Object? value, {
  required String pinnedPublicKey,
  required String expectedApiBaseUrl,
  DateTime? now,
}) async {
  if (value is! Map) _invalid('capability_payload_invalid');
  final signature = value['signature'];
  if (signature is! Map) _invalid('capability_signature_missing');
  if (signature['algorithm'] != 'ed25519') {
    _invalid('capability_signature_algorithm_invalid');
  }
  if (signature['public_key'] != pinnedPublicKey) {
    _invalid('capability_public_key_not_trusted');
  }
  final Uint8List publicKey;
  final Uint8List signatureBytes;
  try {
    publicKey = base64Decode(pinnedPublicKey);
    signatureBytes = base64Decode(_string(signature['value'], 'x'));
  } catch (_) {
    _invalid('capability_signature_invalid');
  }
  if (publicKey.length != 32 || signatureBytes.length != 64) {
    _invalid('capability_signature_invalid');
  }
  final payload = Map<Object?, Object?>.of(value)..remove('signature');
  final canonical = utf8.encode(stableJson(payload));
  if (sha256Hex(canonical) != signature['payload_sha256']) {
    _invalid('capability_payload_hash_mismatch');
  }
  final verified = await Ed25519().verify(
    canonical,
    signature: Signature(
      signatureBytes,
      publicKey: SimplePublicKey(publicKey, type: KeyPairType.ed25519),
    ),
  );
  if (!verified) _invalid('capability_signature_invalid');
  final nowSeconds = (now ?? DateTime.now()).millisecondsSinceEpoch ~/ 1000;
  validateCatalogWindow(value, nowSeconds);
  return parseHostedAgentCatalog(value, expectedApiBaseUrl: expectedApiBaseUrl);
}

String _withoutTrailingSlash(String value) =>
    value.trim().replaceAll(RegExp(r'/+$'), '');

/// Parse an already verified catalog payload.
@visibleForTesting
HostedAgentCatalog parseHostedAgentCatalog(
  Map<Object?, Object?> value, {
  required String expectedApiBaseUrl,
}) {
  final apiBase = _string(value['api_base_url'], 'capability_payload_invalid');
  if (_withoutTrailingSlash(apiBase) !=
      _withoutTrailingSlash(expectedApiBaseUrl)) {
    _invalid('capability_api_base_mismatch');
  }
  final provisioning = value['provisioning_key'];
  if (provisioning is! Map) _invalid('provisioning_key_missing');
  if (provisioning['algorithm'] != null &&
      provisioning['algorithm'] != 'x25519-chacha20poly1305') {
    _invalid('provisioning_key_invalid');
  }
  final Uint8List recipient;
  try {
    recipient = base64Decode(
      _string(provisioning['public_key'], 'provisioning_key_missing'),
    );
  } on HostedAgentException {
    rethrow;
  } catch (_) {
    _invalid('provisioning_key_invalid');
  }
  if (recipient.length != 32) _invalid('provisioning_key_invalid');
  final catalog = value['catalog'];
  if (catalog is! Map) _invalid('capability_catalog_missing');
  final schema = value['config_schema'];
  if (schema is! Map) _invalid('capability_schema_missing');
  final harnesses = <HostedHarness>[];
  final rawHarnesses = catalog['harnesses'];
  if (rawHarnesses is List) {
    for (final entry in rawHarnesses) {
      if (entry is! Map || entry['id'] is! String) continue;
      final models = <HostedModel>[];
      final rawModels = entry['models'];
      if (rawModels is List) {
        for (final model in rawModels) {
          if (model is! Map || model['id'] is! String) continue;
          final tiers = model['service_tiers'];
          models.add(
            HostedModel(
              id: model['id'] as String,
              displayName: model['display_name'] is String
                  ? model['display_name'] as String
                  : model['id'] as String,
              description: model['description'] is String
                  ? model['description'] as String
                  : null,
              isDefault: model['is_default'] == true,
              selectorKind: model['selector_kind'] is String
                  ? model['selector_kind'] as String
                  : 'version',
              reasoningEfforts: _strings(model['supported_reasoning_efforts']),
              serviceTiers: tiers is List
                  ? [
                      for (final tier in tiers)
                        if (tier is Map && tier['id'] is String)
                          tier['id'] as String,
                    ]
                  : const [],
            ),
          );
        }
      }
      harnesses.add(
        HostedHarness(
          id: entry['id'] as String,
          displayName: entry['display_name'] is String
              ? entry['display_name'] as String
              : entry['id'] as String,
          models: List.unmodifiable(models),
        ),
      );
    }
  }
  return HostedAgentCatalog(
    providerId: _string(value['provider_id'], 'capability_payload_invalid'),
    providerName: value['provider_name'] is String
        ? (value['provider_name'] as String).trim()
        : 'Hosted compute',
    apiBaseUrl: apiBase,
    provisioningKeyId: _string(
      provisioning['key_id'],
      'provisioning_key_missing',
    ),
    provisioningPublicKey: recipient,
    catalogVersion: _string(
      catalog['catalog_version'],
      'capability_catalog_version_missing',
    ),
    configSchema: Map<String, Object?>.unmodifiable({
      for (final entry in schema.entries) entry.key.toString(): entry.value,
    }),
    harnesses: List.unmodifiable(harnesses),
  );
}
