import 'dart:convert';
import 'dart:typed_data';

import 'package:buzz/shared/hosted_agents/canonical_json.dart';
import 'package:buzz/shared/hosted_agents/hosted_agent_client.dart';
import 'package:buzz/shared/hosted_agents/hosted_agent_config.dart';
import 'package:buzz/shared/hosted_agents/hosted_agent_errors.dart';
import 'package:buzz/shared/hosted_agents/hosted_agent_proofs.dart';
import 'package:buzz/shared/hosted_agents/hosted_agent_snapshot.dart';
import 'package:buzz/shared/hosted_agents/hosted_owner_attest.dart';
import 'package:buzz/shared/hosted_agents/hosted_owner_rebind.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:nostr/nostr.dart' as nostr;
import 'package:pointycastle/digests/sha256.dart';

import 'hosted_agent_fixtures.dart';

const _ownerSecret =
    '1111111111111111111111111111111111111111111111111111111111111111';
final _owner = nostr.Keys(_ownerSecret).public;
final _oldOwner = nostr.Keys('3' * 64).public;
final _adaKey = nostr.Keys('4' * 64).public;
final _miraKey = nostr.Keys('5' * 64).public;
final _sageKey = nostr.Keys('6' * 64).public;
const _kiingoId = '0a1b2c3d-0000-4000-8000-00000000abcd';

HostedAgentSnapshot _pending(String id, String key, {String name = 'Agent'}) =>
    HostedAgentSnapshot(
      providerAgentId: id,
      agentPublicKey: key,
      displayName: name,
      providerConfig: const {},
      profileRevision: 0,
      desiredState: 'pending_attestation',
      observedState: 'pending_attestation',
      status: hostedAgentStatusPendingAttestation,
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
  List<Map<String, Object?>> results, {
  String? owner,
}) => {
  'contract_version': 1,
  'correlation_id': sent['request_id'],
  'owner_public_key': owner ?? _owner,
  'results': results,
};

Map<String, Object?> _result(
  String id,
  String key,
  String outcome, {
  String? code,
  bool dmOpened = false,
}) => {
  'provider_agent_id': id,
  'agent_public_key': key,
  'kiingo_agent_id': _kiingoId,
  'outcome': outcome,
  'code': code,
  'dm_opened': dmOpened,
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

  group('list', () {
    test('a pending entry parses without a profile or running state', () {
      final snapshot = parseHostedAgentSnapshot({
        'provider_agent_id': 'buzz:scout',
        'agent_public_key': _adaKey,
        'display_name': 'scout',
        'status': 'pending_attestation',
        'kiingo_agent_id': _kiingoId.toUpperCase(),
        'owner_public_key': null,
      })!;
      expect(snapshot.isPendingAttestation, isTrue);
      expect(snapshot.isActive, isFalse);
      expect(snapshot.kiingoAgentId, _kiingoId);
      expect(snapshot.profileRevision, 0);
      // A live agent still needs its profile and state.
      expect(
        parseHostedAgentSnapshot({
          'provider_agent_id': 'buzz:ada',
          'agent_public_key': _adaKey,
          'display_name': 'Ada',
          'status': 'active',
        }),
        isNull,
      );
    });

    test('status defaults to active and unknown values are neither', () {
      Map<String, Object?> live(Object? status) => {
        'provider_agent_id': 'buzz:ada',
        'agent_public_key': _adaKey,
        'display_name': 'Ada',
        'profile': {'profile_revision': 1},
        'desired_state': 'active',
        'observed_state': 'ready',
        'owner_public_key': _oldOwner,
        'status': status,
        'kiingo_agent_id': 'not-a-uuid',
      };
      final legacy = parseHostedAgentSnapshot(live(null))!;
      expect(legacy.isActive, isTrue);
      expect(legacy.kiingoAgentId, isNull);
      final odd = parseHostedAgentSnapshot(live('frozen'))!;
      expect(odd.status, 'unknown');
      // Only live agents are stale; pending and unknown never are.
      final pending = _pending('buzz:p', _miraKey);
      expect(
        staleHostedAgents([
          legacy,
          odd,
          pending,
        ], _owner).map((a) => a.providerAgentId),
        ['buzz:ada'],
      );
      expect(
        pendingHostedAgents([
          legacy,
          odd,
          pending,
        ]).map((a) => a.providerAgentId),
        ['buzz:p'],
      );
    });
  });

  group('request', () {
    test('signs one seven-tag attest_pending proof bound to the body and '
        'attests only the selected agents', () async {
      late Map<String, Object?> sent;
      late Uri url;
      final client = _client(
        MockClient((request) async {
          url = request.url;
          sent = jsonDecode(request.body) as Map<String, Object?>;
          return http.Response(
            jsonEncode(
              _answer(sent, [
                _result('buzz:ada', _adaKey, 'activated', dmOpened: true),
                _result('buzz:mira', _miraKey, 'already_active'),
              ]),
            ),
            200,
          );
        }),
      );
      final before = DateTime.now().millisecondsSinceEpoch ~/ 1000;
      final outcomes = await client.attestPending(
        catalog: catalog,
        selected: [
          _pending('buzz:ada', _adaKey),
          _pending('buzz:mira', _miraKey),
        ],
      );
      final after = DateTime.now().millisecondsSinceEpoch ~/ 1000;

      expect(url.path, endsWith('/owner/agents/attest-pending'));
      expect(sent.keys.toSet(), {
        'contract_version',
        'request_id',
        'agents',
        'owner_proof',
      });
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
        expect(_attestationVerifies(attestation, _sageKey), isFalse);
      }
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
        ['action', 'attest_pending'],
        ['provider', catalog.providerId],
        ['request', sent['request_id']],
        ['agent', ''],
        ['community', 'chat.example.test'],
        ['payload', stableJsonSha256(withoutProof)],
        ['expires', '${createdAt + 300}'],
      ]);
      expect(createdAt, inInclusiveRange(before, after));

      expect(outcomes.map((o) => o.label), ['Linked', 'Already linked']);
      expect(outcomes.first.dmOpened, isTrue);
      expect(outcomes.first.kiingoAgentId, _kiingoId);
      expect(outcomes.every((o) => o.linked), isTrue);
    });

    test('only pending agents, 1 to 20 of them, once each, are signed', () {
      List<HostedAgentSnapshot> many(int count) => [
        for (var index = 0; index < count; index++)
          _pending('buzz:$index', _adaKey),
      ];
      for (final selected in [
        <HostedAgentSnapshot>[],
        many(hostedRebindMaxAgents + 1),
        [_pending('buzz:ada', _adaKey), _pending('buzz:ada', _adaKey)],
        [
          HostedAgentSnapshot(
            providerAgentId: 'buzz:live',
            agentPublicKey: _adaKey,
            displayName: 'Live',
            providerConfig: const {},
            profileRevision: 1,
            desiredState: 'active',
            observedState: 'ready',
          ),
        ],
      ]) {
        expect(
          () => buildHostedAttestBody(
            ownerSecretHex: _ownerSecret,
            requestId: 'r',
            selected: selected,
          ),
          throwsA(
            isA<HostedAgentException>().having(
              (e) => e.code,
              'code',
              'attest_selection_invalid',
            ),
          ),
        );
      }
      expect(
        (buildHostedAttestBody(
                  ownerSecretHex: _ownerSecret,
                  requestId: 'r',
                  selected: many(hostedRebindMaxAgents),
                )['agents']!
                as List)
            .length,
        hostedRebindMaxAgents,
      );
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
                  code: 'buzz_hosted_activate_failed',
                ),
              ]),
            ),
            200,
          );
        }),
      );
      final selected = [_pending('buzz:ada', _adaKey)];
      final first = await client.attestPending(
        catalog: catalog,
        selected: selected,
      );
      expect(first.single.retryable, isTrue);
      expect(bodies, hasLength(1), reason: 'a rejection is not retried');
      await client.attestPending(catalog: catalog, selected: selected);
      expect(bodies[0]['request_id'], isNot(bodies[1]['request_id']));
      expect(
        (bodies[0]['owner_proof']! as Map)['id'],
        isNot((bodies[1]['owner_proof']! as Map)['id']),
      );
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
                'error': 'buzz_hosted_owner_not_linked',
                'correlation_id': 'c1',
              }),
              403,
            );
          }),
        );
        try {
          await client.attestPending(
            catalog: catalog,
            selected: [_pending('buzz:ada', _adaKey)],
          );
          fail('expected a failure');
        } on HostedAgentException catch (error) {
          expect(describeAttestRequestError(error), contains("isn't linked"));
        }
        expect(calls, 1);
      },
    );
  });

  group('response', () {
    final requested = [
      _pending('buzz:ada', _adaKey),
      _pending('buzz:mira', _miraKey),
    ];

    test('every requested agent gets one outcome; a DM failure is linked', () {
      final outcomes = parseHostedAttestResponse(
        _answer(
          {'request_id': 'r'},
          [
            _result(
              'buzz:ada',
              _adaKey,
              'rejected',
              code: 'buzz_hosted_dm_open_failed',
            ),
          ],
        ),
        requestId: 'r',
        ownerPublicKey: _owner,
        requested: requested,
      );
      expect(outcomes.first.linked, isTrue);
      expect(outcomes.first.retryable, isFalse);
      expect(outcomes.first.label, startsWith('Linked'));
      expect(outcomes.last.code, 'result_missing');
      expect(outcomes.last.retryable, isTrue);

      final refused = parseHostedAttestResponse(
        _answer(
          {'request_id': 'r'},
          [
            _result(
              'buzz:ada',
              _adaKey,
              'rejected',
              code: 'buzz_hosted_not_agent_owner',
            ),
          ],
        ),
        requestId: 'r',
        ownerPublicKey: _owner,
        requested: requested.sublist(0, 1),
      ).single;
      expect(refused.linked, isFalse);
      expect(refused.retryable, isFalse);
      expect(refused.label, contains('owner'));
    });

    test('an answer for another request, key, agent or outcome is refused', () {
      for (final bad in [
        {
          ..._answer({'request_id': 'r'}, []),
          'correlation_id': 'other',
        },
        _answer({'request_id': 'r'}, [], owner: _oldOwner),
        _answer(
          {'request_id': 'r'},
          [_result('buzz:sage', _sageKey, 'activated')],
        ),
        _answer(
          {'request_id': 'r'},
          [_result('buzz:ada', _sageKey, 'activated')],
        ),
        _answer(
          {'request_id': 'r'},
          [
            _result('buzz:ada', _adaKey, 'activated'),
            _result('buzz:ada', _adaKey, 'activated'),
          ],
        ),
        _answer({'request_id': 'r'}, [_result('buzz:ada', _adaKey, 'rebound')]),
      ]) {
        expect(
          () => parseHostedAttestResponse(
            bad,
            requestId: 'r',
            ownerPublicKey: _owner,
            requested: requested,
          ),
          throwsA(isA<HostedAgentException>()),
        );
      }
    });
  });
}
