import 'dart:convert';

import 'package:buzz/shared/hosted_agents/hosted_agent_client.dart';
import 'package:buzz/shared/hosted_agents/hosted_agent_config.dart';
import 'package:buzz/shared/hosted_agents/hosted_agent_errors.dart';
import 'package:buzz/shared/hosted_agents/hosted_agent_proofs.dart';
import 'package:buzz/shared/hosted_agents/session_controls.dart';
import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:nostr/nostr.dart' as nostr;

import 'hosted_agent_fixtures.dart';

const _ownerSecret =
    '1111111111111111111111111111111111111111111111111111111111111111';
const _agentKey =
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

HostedAgentClient _client(http.Client http) => HostedAgentClient(
  route: const HostedAgentRoute(
    baseUrl: fixtureApiBase,
    catalogKey: 'k',
    executionLocation: 'example-compute',
    communityId: 'chat.example.test',
    relayUrl: 'wss://chat.example.test',
    relayHttpUrl: 'https://chat.example.test',
  ),
  ownerNsec: nostr.Keys(_ownerSecret).nsec,
  httpClient: http,
);

List<List<String>> _tags(Map<String, Object?> proof) => [
  for (final tag in proof['tags']! as List)
    [for (final value in tag as List) value as String],
];

void main() {
  final catalog = fixtureCatalog(List.filled(32, 7));

  group('client', () {
    test(
      'signs a list-shaped session_controls proof and reads the answer',
      () async {
        late Map<String, Object?> sent;
        final client = _client(
          MockClient((request) async {
            expect(request.method, 'POST');
            expect(request.url.toString(), '$fixtureApiBase/session-controls');
            sent = jsonDecode(request.body) as Map<String, Object?>;
            return http.Response(
              jsonEncode({
                'contract_version': 1,
                'correlation_id': sent['request_id'],
                'agent_public_key': _agentKey,
                'session_controls': true,
              }),
              200,
            );
          }),
        );

        final available = await client.sessionControls(
          catalog: catalog,
          agentPublicKey: _agentKey.toUpperCase(),
        );

        expect(available, isTrue);
        expect(sent['contract_version'], 1);
        expect(sent['agent_public_key'], _agentKey);
        final proof = sent['owner_proof']! as Map<String, Object?>;
        expect(proof['kind'], hostedOwnerProofKind);
        expect(proof['content'], hostedOwnerManagementProofContent);
        expect(proof['pubkey'], nostr.Keys(_ownerSecret).public);
        final tags = _tags(proof);
        expect(tags.map((tag) => tag[0]), [
          'action',
          'provider',
          'request',
          'community',
          'expires',
        ]);
        expect(tags[0], ['action', 'session_controls']);
        expect(tags[1], ['provider', catalog.providerId]);
        expect(tags[2], ['request', sent['request_id']]);
        expect(tags[3], ['community', 'chat.example.test']);
      },
    );

    test('an off answer is false', () async {
      final client = _client(
        MockClient((request) async {
          final body = jsonDecode(request.body) as Map<String, Object?>;
          return http.Response(
            jsonEncode({
              'contract_version': 1,
              'correlation_id': body['request_id'],
              'agent_public_key': _agentKey,
              'session_controls': false,
            }),
            200,
          );
        }),
      );
      expect(
        await client.sessionControls(
          catalog: catalog,
          agentPublicKey: _agentKey,
        ),
        isFalse,
      );
    });

    test('errors and malformed answers throw', () async {
      Future<bool> ask(http.Response Function(Map<String, Object?>) answer) =>
          _client(
            MockClient(
              (request) async =>
                  answer(jsonDecode(request.body) as Map<String, Object?>),
            ),
          ).sessionControls(catalog: catalog, agentPublicKey: _agentKey);

      await expectLater(
        ask(
          (_) => http.Response(
            jsonEncode({'error': 'buzz_hosted_owner_proof_invalid'}),
            403,
          ),
        ),
        throwsA(isA<HostedAgentException>()),
      );
      await expectLater(
        ask(
          (body) => http.Response(
            jsonEncode({
              'contract_version': 1,
              'correlation_id': 'someone-else',
              'agent_public_key': _agentKey,
              'session_controls': true,
            }),
            200,
          ),
        ),
        throwsA(isA<HostedAgentException>()),
      );
      await expectLater(
        ask(
          (body) => http.Response(
            jsonEncode({
              'contract_version': 1,
              'correlation_id': body['request_id'],
              'agent_public_key': _agentKey,
              'session_controls': 'yes',
            }),
            200,
          ),
        ),
        throwsA(isA<HostedAgentException>()),
      );
      await expectLater(
        _client(
          MockClient((_) async => http.Response('{}', 200)),
        ).sessionControls(catalog: catalog, agentPublicKey: 'not-hex'),
        throwsA(isA<HostedAgentException>()),
      );
    });
  });

  group('agentSessionControlsProvider', () {
    ProviderContainer container(SessionControlsLookup? lookup) =>
        ProviderContainer(
          overrides: [sessionControlsLookupProvider.overrideWithValue(lookup)],
        );

    test('without a hosted API there are no session controls', () async {
      final scope = container(null);
      addTearDown(scope.dispose);
      expect(
        await scope.read(agentSessionControlsProvider(_agentKey).future),
        isFalse,
      );
    });

    test('caches an on answer for ten minutes, then asks again', () {
      fakeAsync((async) {
        var calls = 0;
        final scope = container((agent) async {
          calls++;
          expect(agent, _agentKey);
          return true;
        });
        bool? value;
        scope
            .read(agentSessionControlsProvider(_agentKey).future)
            .then((result) => value = result);
        async.flushMicrotasks();
        expect(value, isTrue);
        expect(calls, 1);

        async.elapse(const Duration(minutes: 9));
        scope.read(agentSessionControlsProvider(_agentKey).future);
        async.flushMicrotasks();
        expect(calls, 1, reason: 'still cached');

        async.elapse(const Duration(minutes: 2));
        scope.read(agentSessionControlsProvider(_agentKey).future);
        async.flushMicrotasks();
        expect(calls, 2, reason: 'the ten-minute cache lapsed');
        scope.dispose();
      });
    });

    test('a failed check is off, not retried within two minutes', () {
      fakeAsync((async) {
        var calls = 0;
        final scope = container((_) async {
          calls++;
          throw const HostedAgentException('hosted_agents_timeout');
        });
        bool? value;
        scope
            .read(agentSessionControlsProvider(_agentKey).future)
            .then((result) => value = result);
        async.flushMicrotasks();
        expect(value, isFalse, reason: 'fail closed');

        async.elapse(const Duration(minutes: 1));
        scope.read(agentSessionControlsProvider(_agentKey).future);
        async.flushMicrotasks();
        expect(calls, 1, reason: 'no retry loop');

        async.elapse(const Duration(minutes: 2));
        scope.read(agentSessionControlsProvider(_agentKey).future);
        async.flushMicrotasks();
        expect(calls, 2);
        scope.dispose();
      });
    });

    test('caches per agent key', () async {
      final asked = <String>[];
      final scope = container((agent) async {
        asked.add(agent);
        return agent == _agentKey;
      });
      addTearDown(scope.dispose);
      const other =
          'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      expect(
        await scope.read(agentSessionControlsProvider(_agentKey).future),
        isTrue,
      );
      expect(
        await scope.read(agentSessionControlsProvider(other).future),
        isFalse,
      );
      await scope.read(agentSessionControlsProvider(_agentKey).future);
      expect(asked, [_agentKey, other]);
    });
  });
}
