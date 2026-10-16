import 'dart:convert';

import 'package:buzz/shared/hosted_agents/canonical_json.dart';
import 'package:buzz/shared/hosted_agents/hosted_agent_catalog.dart';
import 'package:buzz/shared/hosted_agents/hosted_agent_config.dart';
import 'package:buzz/shared/hosted_agents/hosted_agent_errors.dart';
import 'package:buzz/shared/hosted_agents/hosted_agent_responses.dart';
import 'package:buzz/shared/hosted_agents/provider_config_schema.dart';
import 'package:cryptography/cryptography.dart';
import 'package:flutter_test/flutter_test.dart';

import 'hosted_agent_fixtures.dart';

Future<Map<String, Object?>> _signed(
  Map<String, Object?> payload,
  SimpleKeyPair signer,
) async {
  final canonical = utf8.encode(stableJson(payload));
  final signature = await Ed25519().sign(canonical, keyPair: signer);
  final publicKey = await signer.extractPublicKey();
  return {
    ...payload,
    'signature': {
      'algorithm': 'ed25519',
      'public_key': base64Encode(publicKey.bytes),
      'payload_sha256': sha256Hex(canonical),
      'value': base64Encode(signature.bytes),
    },
  };
}

void main() {
  group('stableJson', () {
    test('sorts nested keys and keeps array order', () {
      expect(
        stableJson({
          'b': 1,
          'a': {'d': true, 'c': null},
          'e': [
            {'y': 'x', 'x': 'y'},
            2,
          ],
        }),
        '{"a":{"c":null,"d":true},"b":1,"e":[{"x":"y","y":"x"},2]}',
      );
    });
  });

  group('resolveHostedAgentRoute', () {
    HostedAgentRoute? resolve({
      String api = 'https://hosted.example.test/api/hosted/',
      String key = 'k',
      String location = 'loc',
      String routeRelay = 'https://chat.example.test',
      String active = 'https://chat.example.test',
    }) => resolveHostedAgentRoute(
      apiUrl: api,
      catalogKey: key,
      executionLocation: location,
      routeRelayUrl: routeRelay,
      activeRelayHttpUrl: active,
    );

    test('derives the community and normalized relay URLs', () {
      final route = resolve()!;
      expect(route.baseUrl, 'https://hosted.example.test/api/hosted');
      expect(route.communityId, 'chat.example.test');
      expect(route.relayUrl, 'wss://chat.example.test');
      expect(route.relayHttpUrl, 'https://chat.example.test');
    });

    test('is off without full configuration or in another community', () {
      expect(resolve(api: ''), isNull);
      expect(resolve(key: ''), isNull);
      expect(resolve(location: ''), isNull);
      expect(resolve(active: 'https://other.example.test'), isNull);
      expect(resolve(api: 'https://user@hosted.example.test'), isNull);
    });
  });

  group('verifyHostedAgentCatalog', () {
    test('accepts a catalog signed by the pinned key', () async {
      final signer = await Ed25519().newKeyPair();
      final pinned = base64Encode((await signer.extractPublicKey()).bytes);
      final value = await _signed(
        fixtureCatalogPayload(provisioningPublicKey: List.filled(32, 7)),
        signer,
      );
      final catalog = await verifyHostedAgentCatalog(
        value,
        pinnedPublicKey: pinned,
        expectedApiBaseUrl: fixtureApiBase,
      );
      expect(catalog.providerId, 'example');
      expect(catalog.providerName, 'Example Compute');
      expect(catalog.catalogVersion, 'cat-7');
      expect(catalog.harness('codex')!.models.first.selectorKind, 'track');
    });

    test('rejects another signer, tampering, and a foreign API', () async {
      final signer = await Ed25519().newKeyPair();
      final other = await Ed25519().newKeyPair();
      final pinned = base64Encode((await signer.extractPublicKey()).bytes);
      final payload = fixtureCatalogPayload(
        provisioningPublicKey: List.filled(32, 7),
      );

      Future<String> codeFor(Object? value, {String? api}) async {
        try {
          await verifyHostedAgentCatalog(
            value,
            pinnedPublicKey: pinned,
            expectedApiBaseUrl: api ?? fixtureApiBase,
          );
          return 'ok';
        } on HostedAgentException catch (error) {
          return error.code;
        }
      }

      expect(
        await codeFor(await _signed(payload, other)),
        'capability_public_key_not_trusted',
      );
      final tampered = await _signed(payload, signer)
        ..['provider_name'] = 'Spoofed';
      expect(await codeFor(tampered), 'capability_payload_hash_mismatch');
      expect(
        await codeFor(
          await _signed(payload, signer),
          api: 'https://elsewhere.test',
        ),
        'capability_api_base_mismatch',
      );
    });

    test('enforces the validity window', () {
      const now = 1800000000;
      validateCatalogWindow({
        'issued_at_epoch_seconds': now - 60,
        'expires_at_epoch_seconds': now + 60,
      }, now);
      for (final window in [
        {'issued_at_epoch_seconds': now - 120, 'expires_at_epoch_seconds': now},
        {
          'issued_at_epoch_seconds': now + 301,
          'expires_at_epoch_seconds': now + 302,
        },
        {
          'issued_at_epoch_seconds': now,
          'expires_at_epoch_seconds': now + 31 * 24 * 60 * 60 + 1,
        },
      ]) {
        expect(
          () => validateCatalogWindow(window, now),
          throwsA(isA<HostedAgentException>()),
        );
      }
    });
  });

  group('provider config schema', () {
    test('defaults, visibility and family options follow the schema', () {
      final defaults = providerConfigDefaults(fixtureSchema);
      expect(defaults['harness'], 'codex');
      expect(defaults['model_mode'], 'auto');
      final entries = providerConfigEntries(fixtureSchema);
      final selector = entries.firstWhere((e) => e.key == 'model_selector');
      expect(providerConfigFieldVisible(selector.value, defaults), isFalse);

      final track = reconcileProviderConfig(
        entries,
        defaults,
        'model_mode',
        'track',
      );
      expect(providerConfigFieldVisible(selector.value, track), isTrue);
      expect(
        providerConfigOptions(selector.value, track)!.map((o) => o.value),
        ['sol'],
      );
      // A family must be chosen before create.
      expect(providerConfigUnmetChoices(fixtureSchema, track), [
        'model_selector',
      ]);
      expect(providerConfigComplete(fixtureSchema, track), isFalse);
      final chosen = reconcileProviderConfig(
        entries,
        track,
        'model_selector',
        'sol',
      );
      expect(providerConfigComplete(fixtureSchema, chosen), isTrue);

      // Switching harness drops a model that no longer exists.
      final switched = reconcileProviderConfig(
        entries,
        chosen,
        'harness',
        'claude-code',
      );
      expect(switched['model_selector'], '');
    });

    test('coerces integers and keeps strings', () {
      final typed = coerceProviderConfig(
        providerConfigDefaults(fixtureSchema),
        fixtureSchema,
      );
      expect(typed['profile_revision'], 1);
      expect(typed['harness'], 'codex');
      expect(typed['model_selector'], '');
    });
  });

  group('responses', () {
    test('preflight keeps only bounded text and https actions', () {
      final result = parseHostedPreflight({
        'contract_version': 1,
        'correlation_id': 'req-1',
        'ready': false,
        'message': 'Connect your subscription.',
        'notice': 'Senders pay.',
        'action_label': 'Connect',
        'action_url': 'https://dashboard.example.test/connect',
      }, 'req-1');
      expect(result.ready, isFalse);
      expect(result.actionLabel, 'Connect');
      expect(result.actionUrl, 'https://dashboard.example.test/connect');

      final unsafe = parseHostedPreflight({
        'contract_version': 1,
        'correlation_id': 'req-1',
        'ready': true,
        'message': 'x' * 301,
        'action_label': 'Open',
        'action_url': 'javascript:alert(1)',
      }, 'req-1');
      expect(unsafe.message, isNull);
      expect(unsafe.actionUrl, isNull);
      expect(unsafe.actionLabel, isNull);

      expect(
        () => parseHostedPreflight({
          'contract_version': 1,
          'correlation_id': 'other',
          'ready': true,
        }, 'req-1'),
        throwsA(isA<HostedAgentException>()),
      );
    });

    test('confirmed delete must be exactly terminal', () {
      final terminal = {
        'contract_version': 1,
        'provider_agent_id': 'agent-1',
        'observed_state': 'deleted',
        'identity_destroyed': true,
        'correlation_id': 'req-1',
      };
      validateConfirmedDelete(
        terminal,
        requestId: 'req-1',
        providerAgentId: 'agent-1',
      );
      for (final body in [
        {...terminal, 'observed_state': 'deleting'},
        {...terminal, 'identity_destroyed': false},
        {...terminal, 'extra': 1},
        {...terminal, 'correlation_id': 'req-2'},
      ]) {
        expect(
          () => validateConfirmedDelete(
            body,
            requestId: 'req-1',
            providerAgentId: 'agent-1',
          ),
          throwsA(isA<HostedAgentException>()),
        );
      }
    });

    test('failure mapping keeps bounded fields and agent_state', () {
      final failure = hostedAgentFailure(
        {
          'error': 'buzz_codex_subscription_not_connected',
          'message': 'Connect your subscription, then retry.',
          'remediation_url': 'https://dashboard.example.test/connect',
          'correlation_id': 'req-1',
          'agent_state': 'absent',
        },
        status: 400,
        fallbackCode: 'provisioning_failed',
        readAgentState: true,
      );
      expect(failure.code, 'buzz_codex_subscription_not_connected');
      expect(failure.remoteAbsent, isTrue);
      expect(failure.supportId, 'req-1');

      final unknown = hostedAgentFailure(
        {'error': 'has spaces', 'agent_state': 'present'},
        status: 503,
        fallbackCode: 'provisioning_failed',
        readAgentState: true,
      );
      expect(unknown.code, 'provisioning_failed');
      expect(unknown.remoteAbsent, isFalse);
    });
  });
}
