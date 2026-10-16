import 'dart:convert';

import 'package:buzz/shared/hosted_agents/hosted_agent_catalog.dart';

/// API base the fixtures are issued for.
const fixtureApiBase = 'https://hosted.example.test/api/hosted';

/// A catalog payload (without signature) shaped like the API's.
Map<String, Object?> fixtureCatalogPayload({
  required List<int> provisioningPublicKey,
  int? issuedAt,
}) {
  final now = issuedAt ?? DateTime.now().millisecondsSinceEpoch ~/ 1000;
  return {
    'contract_version': 1,
    'issued_at_epoch_seconds': now,
    'expires_at_epoch_seconds': now + 24 * 60 * 60,
    'provider_id': 'example',
    'provider_name': 'Example Compute',
    'api_base_url': fixtureApiBase,
    'provisioning_key': {
      'key_id': 'prov-1',
      'algorithm': 'x25519-chacha20poly1305',
      'public_key': base64Encode(provisioningPublicKey),
    },
    'catalog': {
      'contract_version': 1,
      'catalog_version': 'cat-7',
      'harnesses': [
        {
          'id': 'codex',
          'display_name': 'Codex CLI',
          'models': [
            {
              'id': 'sol',
              'display_name': 'Sol',
              'is_default': true,
              'selector_kind': 'track',
              'supported_reasoning_efforts': ['low', 'high'],
              'service_tiers': [
                {'id': 'fast', 'name': 'Fast'},
              ],
            },
            {
              'id': 'sol-2026-09',
              'display_name': 'Sol (Sept 2026)',
              'selector_kind': 'version',
              'supported_reasoning_efforts': <String>[],
              'service_tiers': <Object>[],
            },
          ],
        },
        {
          'id': 'claude-code',
          'display_name': 'Claude Code',
          'models': [
            {
              'id': 'opus',
              'display_name': 'Opus',
              'selector_kind': 'track',
              'supported_reasoning_efforts': <String>[],
              'service_tiers': <Object>[],
            },
          ],
        },
      ],
    },
    'config_schema': fixtureSchema,
  };
}

/// The API's execution-profile schema, trimmed to the fields that matter.
const fixtureSchema = <String, Object?>{
  'type': 'object',
  'required': ['harness', 'model_mode', 'profile_revision'],
  'properties': {
    'harness': {
      'type': 'string',
      'title': 'Harness',
      'enum': ['codex', 'claude-code'],
      'default': 'codex',
      'x-enum-labels': {'codex': 'Codex', 'claude-code': 'Claude Code'},
    },
    'model_mode': {
      'type': 'string',
      'title': 'Model',
      'enum': ['auto', 'track', 'version'],
      'default': 'auto',
    },
    'model_selector': {
      'type': 'string',
      'title': 'Model selection',
      'default': '',
      'x-visible-when': {'field': 'model_mode', 'not': 'auto'},
      'x-options-by-field': {
        'field': 'harness',
        'options': {
          'codex': [
            {'value': 'sol', 'label': 'Sol', 'selector_kind': 'track'},
            {
              'value': 'sol-2026-09',
              'label': 'Sol (Sept 2026)',
              'selector_kind': 'version',
            },
          ],
          'claude-code': [
            {'value': 'opus', 'label': 'Opus', 'selector_kind': 'track'},
          ],
        },
      },
      'x-option-filter': {
        'field': 'model_mode',
        'option_property': 'selector_kind',
      },
    },
    'reasoning_effort': {
      'type': 'string',
      'title': 'Reasoning effort',
      'default': 'auto',
      'x-visible-when': {'field': 'model_mode', 'not': 'auto'},
      'x-options-by-fields': {
        'fields': ['harness', 'model_selector'],
        'options': {
          'codex|sol': [
            {'value': 'auto', 'label': 'Automatic'},
            {'value': 'low', 'label': 'Low'},
            {'value': 'high', 'label': 'High'},
          ],
        },
      },
      'x-hide-when-no-options': true,
    },
    'capability_catalog_version': {
      'type': 'string',
      'default': 'cat-7',
      'readOnly': true,
      'x-hidden': true,
    },
    'profile_revision': {
      'type': 'integer',
      'default': 1,
      'readOnly': true,
      'x-hidden': true,
    },
  },
};

/// A parsed catalog without signature verification.
HostedAgentCatalog fixtureCatalog(List<int> provisioningPublicKey) =>
    parseHostedAgentCatalog(
      fixtureCatalogPayload(provisioningPublicKey: provisioningPublicKey),
      expectedApiBaseUrl: fixtureApiBase,
    );
