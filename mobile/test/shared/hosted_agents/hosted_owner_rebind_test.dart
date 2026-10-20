import 'dart:convert';
import 'dart:typed_data';

import 'package:buzz/shared/hosted_agents/canonical_json.dart';
import 'package:buzz/shared/hosted_agents/hosted_agent_client.dart';
import 'package:buzz/shared/hosted_agents/hosted_agent_config.dart';
import 'package:buzz/shared/hosted_agents/hosted_agent_errors.dart';
import 'package:buzz/shared/hosted_agents/hosted_agent_proofs.dart';
import 'package:buzz/shared/hosted_agents/hosted_agent_snapshot.dart';
import 'package:buzz/shared/hosted_agents/hosted_owner_rebind.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:nostr/nostr.dart' as nostr;
import 'package:pointycastle/digests/sha256.dart';

import 'hosted_agent_fixtures.dart';

const _ownerSecret =
    '1111111111111111111111111111111111111111111111111111111111111111';
const _oldOwnerSecret =
    '3333333333333333333333333333333333333333333333333333333333333333';
final _owner = nostr.Keys(_ownerSecret).public;
final _oldOwner = nostr.Keys(_oldOwnerSecret).public;
final _adaKey = nostr.Keys('4' * 64).public;
final _miraKey = nostr.Keys('5' * 64).public;
final _sageKey = nostr.Keys('6' * 64).public;

HostedAgentSnapshot _agent(
  String id,
  String key, {
  String? owner,
  String name = 'Agent',
  String desired = 'active',
}) => HostedAgentSnapshot(
  providerAgentId: id,
  agentPublicKey: key,
  displayName: name,
  providerConfig: const {},
  profileRevision: 1,
  desiredState: desired,
  observedState: 'ready',
  ownerPublicKey: owner,
);

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

Map<String, Object?> _answer(
  Map<String, Object?> sent,
  List<Map<String, Object?>> results,
) => {
  'contract_version': 1,
  'correlation_id': sent['request_id'],
  'owner_public_key': _owner,
  'results': results,
};

Map<String, Object?> _result(
  String id,
  String key,
  String outcome, {
  String? code,
}) => {
  'provider_agent_id': id,
  'agent_public_key': key,
  'outcome': outcome,
  'code': code,
  'profile_revision': 2,
  'profile_republished': true,
};

bool _attestationVerifies(String attestation, String agentKey) {
  final tag = jsonDecode(attestation) as List;
  if (tag.length != 4 || tag[0] != 'auth' || tag[2] != '') return false;
  final digest = SHA256Digest().process(
    Uint8List.fromList(utf8.encode('nostr:agent-auth:$agentKey:')),
  );
  return nostr.Schnorr.verify(
    publicKey: tag[1] as String,
    message: hexEncode(digest),
    signature: tag[3] as String,
  );
}

void main() {
  final catalog = fixtureCatalog(List.filled(32, 7));

  group('stale detection', () {
    test('only a reported owner key other than the current one is stale', () {
      final agents = [
        _agent('buzz:ada', _adaKey, owner: _oldOwner),
        _agent('buzz:mira', _miraKey, owner: _owner),
        _agent('buzz:sage', _sageKey),
        _agent(
          'buzz:gone',
          nostr.Keys('7' * 64).public,
          owner: _oldOwner,
          desired: 'deleted',
        ),
      ];
      expect(staleHostedAgents(agents, _owner).map((a) => a.providerAgentId), [
        'buzz:ada',
      ]);
      expect(
        currentHostedAgents(agents, _owner).map((a) => a.providerAgentId),
        ['buzz:mira'],
      );
      // The comparison ignores hex case.
      expect(staleHostedAgents(agents, _owner.toUpperCase()), hasLength(1));
      expect(staleHostedAgents([agents[1]], _owner), isEmpty);
    });

    test(
      'the list parser reads owner_public_key and drops malformed values',
      () {
        Map<String, Object?> state(Object? owner) => {
          'provider_agent_id': 'buzz:ada',
          'agent_public_key': _adaKey,
          'display_name': 'Ada',
          'profile': {'profile_revision': 1},
          'desired_state': 'active',
          'observed_state': 'ready',
          'owner_public_key': owner,
        };
        expect(
          parseHostedAgentSnapshot(
            state(_oldOwner.toUpperCase()),
          )!.ownerPublicKey,
          _oldOwner,
        );
        expect(parseHostedAgentSnapshot(state(null))!.ownerPublicKey, isNull);
        expect(parseHostedAgentSnapshot(state('xyz'))!.ownerPublicKey, isNull);
      },
    );
  });

  group('request', () {
    test('signs one seven-tag proof bound to the body and attests only the '
        'selected agents', () async {
      late Map<String, Object?> sent;
      late Uri url;
      final client = _client(
        MockClient((request) async {
          url = request.url;
          sent = jsonDecode(request.body) as Map<String, Object?>;
          return http.Response(
            jsonEncode(
              _answer(sent, [
                _result('buzz:ada', _adaKey, 'rebound'),
                _result('buzz:mira', _miraKey, 'already_current'),
              ]),
            ),
            200,
          );
        }),
      );
      final before = DateTime.now().millisecondsSinceEpoch ~/ 1000;
      final outcomes = await client.rebindOwnerKey(
        catalog: catalog,
        selected: [
          _agent('buzz:ada', _adaKey, owner: _oldOwner),
          _agent('buzz:mira', _miraKey, owner: _oldOwner),
        ],
      );
      final after = DateTime.now().millisecondsSinceEpoch ~/ 1000;

      expect(url.path, endsWith('/owner/agents/rebind-owner-key'));
      expect(sent.keys.toSet(), {
        'contract_version',
        'request_id',
        'agents',
        'owner_proof',
      });
      expect(sent['contract_version'], 1);
      final agents = (sent['agents']! as List).cast<Map<String, Object?>>();
      expect(agents.map((a) => a['provider_agent_id']), [
        'buzz:ada',
        'buzz:mira',
      ]);
      for (final agent in agents) {
        expect(agent.keys.toSet(), {
          'provider_agent_id',
          'agent_public_key',
          'owner_attestation',
        });
        final attestation = agent['owner_attestation']! as String;
        expect(utf8.encode(attestation).length, lessThanOrEqualTo(512));
        expect((jsonDecode(attestation) as List)[1], _owner);
        expect(
          _attestationVerifies(
            attestation,
            agent['agent_public_key']! as String,
          ),
          isTrue,
        );
      }
      // Sage was not selected: no attestation for it anywhere.
      expect(jsonEncode(sent), isNot(contains(_sageKey)));

      final proof = sent['owner_proof']! as Map<String, Object?>;
      expect(nostr.Event.fromMap(proof.cast<String, dynamic>()).pubkey, _owner);
      expect(proof['kind'], hostedOwnerProofKind);
      expect(proof['content'], 'buzz-provider-owner-v1');
      final tags = (proof['tags']! as List)
          .map((tag) => (tag as List).cast<String>())
          .toList();
      final withoutProof = Map<String, Object?>.of(sent)..remove('owner_proof');
      final createdAt = proof['created_at']! as int;
      expect(tags, [
        ['action', 'rebind_owner_key'],
        ['provider', catalog.providerId],
        ['request', sent['request_id']],
        ['agent', ''],
        ['community', 'chat.example.test'],
        ['payload', stableJsonSha256(withoutProof)],
        ['expires', '${createdAt + 300}'],
      ]);
      // Fresh: signed now, expiring within five minutes.
      expect(createdAt, inInclusiveRange(before, after));
      expect(int.parse(tags.last[1]) - createdAt, lessThanOrEqualTo(5 * 60));

      expect(outcomes.map((o) => o.label), ['Re-linked', 'Already linked']);
    });

    test('every call uses a new request id and a new proof', () async {
      final bodies = <Map<String, Object?>>[];
      final client = _client(
        MockClient((request) async {
          final sent = jsonDecode(request.body) as Map<String, Object?>;
          bodies.add(sent);
          return http.Response(
            jsonEncode(
              _answer(sent, [
                _result(
                  'buzz:ada',
                  _adaKey,
                  'rejected',
                  code: 'buzz_hosted_rebind_failed',
                ),
              ]),
            ),
            200,
          );
        }),
      );
      final selected = [_agent('buzz:ada', _adaKey, owner: _oldOwner)];
      final first = await client.rebindOwnerKey(
        catalog: catalog,
        selected: selected,
      );
      expect(first.single.retryable, isTrue);
      expect(bodies, hasLength(1), reason: 'a rejection is not retried');
      await client.rebindOwnerKey(catalog: catalog, selected: selected);
      expect(bodies, hasLength(2));
      expect(bodies[0]['request_id'], isNot(bodies[1]['request_id']));
      final proofs = [
        for (final body in bodies) body['owner_proof']! as Map<String, Object?>,
      ];
      expect(proofs[0]['id'], isNot(proofs[1]['id']));
    });

    test(
      'a whole-request error is not retried and maps to one sentence',
      () async {
        var calls = 0;
        final client = _client(
          MockClient((request) async {
            calls++;
            return http.Response(
              jsonEncode({
                'error': 'buzz_hosted_owner_proof_replayed',
                'correlation_id': 'c1',
              }),
              403,
            );
          }),
        );
        try {
          await client.rebindOwnerKey(
            catalog: catalog,
            selected: [_agent('buzz:ada', _adaKey, owner: _oldOwner)],
          );
          fail('expected a failure');
        } on HostedAgentException catch (error) {
          expect(describeRebindRequestError(error), contains('already used'));
        }
        expect(calls, 1);
      },
    );

    test('an empty, oversized or duplicate selection signs nothing', () {
      expect(
        () => buildHostedRebindBody(
          ownerSecretHex: _ownerSecret,
          requestId: 'r',
          selected: const [],
        ),
        throwsA(isA<HostedAgentException>()),
      );
      final many = [
        for (var i = 0; i < hostedRebindMaxAgents + 1; i++)
          _agent('buzz:$i', _adaKey, owner: _oldOwner),
      ];
      expect(
        () => buildHostedRebindBody(
          ownerSecretHex: _ownerSecret,
          requestId: 'r',
          selected: many,
        ),
        throwsA(isA<HostedAgentException>()),
      );
      final ada = _agent('buzz:ada', _adaKey, owner: _oldOwner);
      expect(
        () => buildHostedRebindBody(
          ownerSecretHex: _ownerSecret,
          requestId: 'r',
          selected: [ada, ada],
        ),
        throwsA(isA<HostedAgentException>()),
      );
    });
  });

  group('outcomes', () {
    final requested = [
      _agent('buzz:ada', _adaKey, owner: _oldOwner),
      _agent('buzz:mira', _miraKey, owner: _oldOwner),
    ];

    test('reject codes map to short sentences and only two retry', () {
      const retryable = {'profile_revision_conflict', 'rebind_failed'};
      for (final code in [
        'endpoint_not_found',
        'agent_key_mismatch',
        'owner_attestation_invalid',
        'previous_owner_not_revoked',
        'identity_unreadable',
        'rotation_in_progress',
        'profile_revision_conflict',
        'rebind_failed',
      ]) {
        final outcomes = parseHostedRebindResponse(
          {
            'contract_version': 1,
            'correlation_id': 'r1',
            'owner_public_key': _owner,
            'results': [
              _result(
                'buzz:ada',
                _adaKey,
                'rejected',
                code: 'buzz_hosted_$code',
              ),
              _result('buzz:mira', _miraKey, 'rebound'),
            ],
          },
          requestId: 'r1',
          ownerPublicKey: _owner,
          requested: requested,
        );
        final ada = outcomes.first;
        expect(ada.status, HostedRebindStatus.rejected);
        expect(ada.code, code);
        expect(ada.retryable, retryable.contains(code), reason: code);
        expect(ada.label, isNot(describeRebindRejection('unknown_code')));
        expect(ada.label.endsWith('.'), isTrue);
        expect(outcomes.last.label, 'Re-linked');
      }
    });

    test('a requested agent the answer leaves out can be retried', () {
      final outcomes = parseHostedRebindResponse(
        {
          'contract_version': 1,
          'correlation_id': 'r1',
          'owner_public_key': _owner,
          'results': [_result('buzz:ada', _adaKey, 'rebound')],
        },
        requestId: 'r1',
        ownerPublicKey: _owner,
        requested: requested,
      );
      expect(outcomes.last.providerAgentId, 'buzz:mira');
      expect(outcomes.last.retryable, isTrue);
    });

    test('answers for another request, owner or agent are refused', () {
      Map<String, Object?> body({
        String correlation = 'r1',
        String? owner,
        List<Map<String, Object?>>? results,
      }) => {
        'contract_version': 1,
        'correlation_id': correlation,
        'owner_public_key': owner ?? _owner,
        'results': results ?? [_result('buzz:ada', _adaKey, 'rebound')],
      };
      for (final bad in [
        body(correlation: 'other'),
        body(owner: _oldOwner),
        body(results: [_result('buzz:sage', _sageKey, 'rebound')]),
        body(results: [_result('buzz:ada', _miraKey, 'rebound')]),
        body(
          results: [
            _result('buzz:ada', _adaKey, 'rebound'),
            _result('buzz:ada', _adaKey, 'rebound'),
          ],
        ),
        body(results: [_result('buzz:ada', _adaKey, 'maybe')]),
      ]) {
        expect(
          () => parseHostedRebindResponse(
            bad,
            requestId: 'r1',
            ownerPublicKey: _owner,
            requested: requested,
          ),
          throwsA(isA<HostedAgentException>()),
        );
      }
    });

    test('whole-request codes each get one sentence', () {
      for (final code in [
        'buzz_hosted_rebind_invalid',
        'buzz_hosted_owner_proof_invalid',
        'buzz_hosted_owner_proof_replayed',
        'buzz_hosted_owner_not_linked',
        'buzz_hosted_owner_ambiguous',
        'buzz_hosted_scope_unconfigured',
        'buzz_hosted_provisioning_keys_unconfigured',
        'buzz_hosted_provisioning_keys_invalid',
        'buzz_hosted_database_unavailable',
      ]) {
        final text = describeRebindRequestError(HostedAgentException(code));
        expect(text, isNot(describeHostedAgentError('')), reason: code);
        expect('.'.allMatches(text).length, 1, reason: code);
      }
    });
  });
}
