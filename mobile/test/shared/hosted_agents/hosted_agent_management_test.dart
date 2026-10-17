import 'dart:convert';

import 'package:buzz/shared/hosted_agents/canonical_json.dart';
import 'package:buzz/shared/hosted_agents/hosted_agent_client.dart';
import 'package:buzz/shared/hosted_agents/hosted_agent_config.dart';
import 'package:buzz/shared/hosted_agents/hosted_agent_errors.dart';
import 'package:buzz/shared/hosted_agents/hosted_agent_proofs.dart';
import 'package:buzz/shared/hosted_agents/hosted_agent_snapshot.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:nostr/nostr.dart' as nostr;

import 'hosted_agent_fixtures.dart';

const _ownerSecret =
    '1111111111111111111111111111111111111111111111111111111111111111';
const _agentKey =
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

Map<String, Object?> _state({
  String id = 'buzz:1',
  int revision = 3,
  String desired = 'active',
  String observed = 'ready',
}) => {
  'contract_version': 1,
  'provider_agent_id': id,
  'agent_public_key': _agentKey,
  'display_name': 'Scout',
  'provider_config': {
    'harness': 'codex',
    'model_mode': 'track',
    'model_selector': 'sol',
    'reasoning_effort': 'auto',
    'service_tier': 'auto',
  },
  'agent_instructions': {
    'version': 1,
    'profile_revision': revision,
    'system_prompt': 'Be brief.',
  },
  'profile': {'profile_revision': revision},
  'desired_state': desired,
  'observed_state': observed,
  'last_ready_at': '2026-10-16T12:00:00.000Z',
  'error_code': null,
  'correlation_id': 'c',
};

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

Map<String, String> _tags(Map<String, Object?> proof) => {
  for (final tag in proof['tags']! as List)
    (tag as List)[0] as String: tag[1] as String,
};

void main() {
  final catalog = fixtureCatalog(List.filled(32, 7));

  test('snapshot parsing reads live state and revision', () {
    final agent = parseHostedAgentSnapshot(_state(desired: 'paused'))!;
    expect(agent.providerAgentId, 'buzz:1');
    expect(agent.profileRevision, 3);
    expect(agent.isPaused, isTrue);
    expect(agent.systemPrompt, 'Be brief.');
    expect(agent.formConfig['model_selector'], 'sol');
    expect(hostedProfileLabels(catalog, agent.providerConfig), (
      harness: 'Codex',
      model: 'Sol',
    ));
    expect(parseHostedAgentSnapshot({..._state(), 'profile': {}}), isNull);
    expect(
      () => parseHostedAgentList({
        'contract_version': 1,
        'agents': [_state()],
        'correlation_id': 'other',
      }, 'mine'),
      throwsA(isA<HostedAgentException>()),
    );
  });

  test('list signs a five-tag owner proof', () async {
    late Map<String, Object?> sent;
    final client = _client(
      MockClient((request) async {
        sent = jsonDecode(request.body) as Map<String, Object?>;
        expect(request.url.path, endsWith('/owner/agents/list'));
        return http.Response(
          jsonEncode({
            'contract_version': 1,
            'agents': [_state()],
            'correlation_id': sent['request_id'],
          }),
          200,
        );
      }),
    );
    final agents = await client.listAgents(catalog: catalog);
    expect(agents.single.displayName, 'Scout');
    final proof = sent['owner_proof']! as Map<String, Object?>;
    expect(proof['content'], hostedOwnerManagementProofContent);
    expect(_tags(proof).keys, [
      'action',
      'provider',
      'request',
      'community',
      'expires',
    ]);
    expect(_tags(proof)['action'], 'list');
    expect(_tags(proof)['request'], sent['request_id']);
  });

  test(
    'a write binds the canonical body and re-signs a replayed proof',
    () async {
      final bodies = <Map<String, Object?>>[];
      final client = _client(
        MockClient((request) async {
          final body = jsonDecode(request.body) as Map<String, Object?>;
          bodies.add(body);
          if (bodies.length == 1) {
            return http.Response(
              jsonEncode({'error': 'buzz_hosted_owner_proof_replayed'}),
              403,
            );
          }
          return http.Response(jsonEncode(_state(desired: 'paused')), 200);
        }),
      );
      final result = await client.controlAgent(
        catalog: catalog,
        providerAgentId: 'buzz:1',
        expectedRevision: 3,
        action: 'pause',
      );
      expect(result.isPaused, isTrue);
      expect(bodies, hasLength(2));
      final first = bodies[0];
      final second = bodies[1];
      // Same request id (idempotent retry), fresh single-use proof.
      expect(first['request_id'], second['request_id']);
      final firstProof = first['owner_proof']! as Map<String, Object?>;
      final secondProof = second['owner_proof']! as Map<String, Object?>;
      expect(firstProof['id'], isNot(secondProof['id']));
      final tags = _tags(secondProof);
      expect(tags.keys, [
        'action',
        'provider',
        'request',
        'agent',
        'community',
        'payload',
        'expires',
      ]);
      expect(tags['action'], 'control');
      expect(tags['agent'], 'buzz:1');
      final withoutProof = Map<String, Object?>.of(second)
        ..remove('owner_proof');
      expect(tags['payload'], stableJsonSha256(withoutProof));
      expect(withoutProof['expected_profile_revision'], 3);
      expect(withoutProof['action'], 'pause');
    },
  );

  test('a revision conflict is surfaced, not retried', () async {
    var calls = 0;
    final client = _client(
      MockClient((request) async {
        calls++;
        return http.Response(
          jsonEncode({
            'error': 'buzz_hosted_profile_revision_conflict',
            'correlation_id': 'req',
          }),
          409,
        );
      }),
    );
    await expectLater(
      client.updateAgent(
        catalog: catalog,
        providerAgentId: 'buzz:1',
        expectedRevision: 3,
        displayName: 'Scout',
        providerConfig: const {'harness': 'codex', 'model_mode': 'auto'},
        systemPrompt: null,
      ),
      throwsA(
        isA<HostedAgentException>().having(
          isHostedRevisionConflict,
          'conflict',
          isTrue,
        ),
      ),
    );
    expect(calls, 1);
  });

  test('retry classification', () {
    expect(
      isRetryableOwnerWriteFailure(
        const HostedAgentException('hosted_agents_timeout'),
      ),
      isTrue,
    );
    expect(
      isRetryableOwnerWriteFailure(
        const HostedAgentException('buzz_hosted_profile_revision_conflict'),
      ),
      isFalse,
    );
  });
}
