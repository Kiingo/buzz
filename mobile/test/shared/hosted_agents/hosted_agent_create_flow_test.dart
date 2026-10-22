import 'dart:convert';
import 'dart:typed_data';

import 'package:buzz/shared/crypto/nip_oa.dart';
import 'package:buzz/shared/hosted_agents/canonical_json.dart';
import 'package:buzz/shared/hosted_agents/hosted_agent_catalog.dart';
import 'package:buzz/shared/hosted_agents/hosted_agent_create_flow.dart';
import 'package:buzz/shared/hosted_agents/hosted_agent_deploy_request.dart';
import 'package:buzz/shared/hosted_agents/hosted_agent_errors.dart';
import 'package:buzz/shared/hosted_agents/hosted_agent_identity.dart';
import 'package:buzz/shared/hosted_agents/hosted_agent_proofs.dart';
import 'package:buzz/shared/hosted_agents/hosted_agent_responses.dart';
import 'package:cryptography/cryptography.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nostr/nostr.dart' as nostr;
import 'package:pointycastle/digests/sha256.dart';

import 'hosted_agent_fixtures.dart';

const _ownerSecret =
    '1111111111111111111111111111111111111111111111111111111111111111';
const _agentSecret =
    '2222222222222222222222222222222222222222222222222222222222222222';

class _FakeProvisioner implements HostedAgentProvisioner {
  _FakeProvisioner(this.provisionResults, {this.deleteResults = const []});

  /// Each entry is a [HostedAgentState] or a [HostedAgentException].
  final List<Object> provisionResults;
  final List<Object?> deleteResults;
  final provisionRequests = <Map<String, Object?>>[];
  final deletedIds = <String>[];

  @override
  Future<HostedAgentState> provision(Map<String, Object?> request) async {
    provisionRequests.add(request);
    final result = provisionResults[provisionRequests.length - 1];
    if (result is HostedAgentException) throw result;
    return result as HostedAgentState;
  }

  @override
  Future<void> confirmedDelete({
    required HostedAgentCatalog catalog,
    required String providerAgentId,
  }) async {
    deletedIds.add(providerAgentId);
    final index = deletedIds.length - 1;
    final result = index < deleteResults.length ? deleteResults[index] : null;
    if (result is HostedAgentException) throw result;
  }
}

void main() {
  late SimpleKeyPair recipient;
  late HostedAgentCatalog catalog;

  setUp(() async {
    recipient = await X25519().newKeyPair();
    final recipientPublic = await recipient.extractPublicKey();
    catalog = fixtureCatalog(recipientPublic.bytes);
  });

  HostedAgentScope scopeFor(HostedAgentIdentity identity) => HostedAgentScope(
    communityId: 'chat.example.test',
    relayUrl: 'wss://chat.example.test',
    executionLocation: 'example-compute',
    ownerAttestation: computeOwnerAttestation(
      ownerSecretHex: _ownerSecret,
      agentPublicKey: identity.publicKey,
    ),
  );

  const draft = HostedAgentDraft(
    displayName: ' Assistant ',
    systemPrompt: '  Be brief.  ',
    providerConfig: {
      'harness': 'codex',
      'model_mode': 'track',
      'model_selector': 'sol',
      'reasoning_effort': 'high',
      'service_tier': 'auto',
      'capability_catalog_version': 'cat-7',
      'profile_revision': 1,
    },
  );

  test('owner attestation is a verifiable unrestricted NIP-OA tag', () {
    final agent = HostedAgentIdentity.fromSecretHex(_agentSecret);
    final tag = (jsonDecode(scopeFor(agent).ownerAttestation) as List)
        .cast<String>();
    expect(tag[0], 'auth');
    expect(tag[2], '');
    expect(
      verifiedOaOwnerPubkey([tag], agent.publicKey),
      nostr.Keys(_ownerSecret).public,
    );
  });

  test('the envelope opens with the provisioning key and binds AAD', () async {
    final agent = HostedAgentIdentity.fromSecretHex(_agentSecret);
    final scope = scopeFor(agent);
    final request = await buildHostedProvisionRequest(
      requestId: '00000000-0000-4000-8000-000000000001',
      identity: agent,
      draft: draft,
      scope: scope,
      catalog: catalog,
    );
    expect(request['display_name'], 'Assistant');
    expect(request['relay_url'], 'wss://chat.example.test');
    final instructions = request['agent_instructions']! as Map;
    expect(instructions['system_prompt'], 'Be brief.');
    final profile = request['execution_profile']! as Map;
    expect(profile['execution_location'], 'example-compute');
    expect((profile['execution'] as Map)['model'], {
      'mode': 'track',
      'id': 'sol',
    });

    final envelope = request['identity_envelope']! as Map;
    final aadValue = identityAssociatedData(
      communityId: scope.communityId,
      relayUrl: scope.relayUrl,
      agentPublicKey: agent.publicKey,
      providerConfigSha256: stableJsonSha256(draft.providerConfig),
    );
    final aad = utf8.encode(stableJson(aadValue));
    expect(envelope['associated_data_sha256'], sha256Hex(aad));

    final shared = await X25519().sharedSecretKey(
      keyPair: recipient,
      remotePublicKey: SimplePublicKey(
        base64Decode(envelope['ephemeral_public_key'] as String),
        type: KeyPairType.x25519,
      ),
    );
    final key = SHA256Digest().process(
      Uint8List.fromList([
        ...utf8.encode('kiingo-buzz-identity-v2'),
        ...await shared.extractBytes(),
      ]),
    );
    final sealed = base64Decode(envelope['ciphertext'] as String);
    final bundle = await Chacha20.poly1305Aead().decrypt(
      SecretBox(
        sealed.sublist(0, sealed.length - 16),
        nonce: base64Decode(envelope['nonce'] as String),
        mac: Mac(sealed.sublist(sealed.length - 16)),
      ),
      secretKey: SecretKey(key),
      aad: aad,
    );
    expect(utf8.decode(bundle.sublist(0, 4)), 'KBZ2');
    expect(hexEncode(bundle.sublist(4, 36)), _agentSecret);
    final length = (bundle[36] << 8) | bundle[37];
    expect(utf8.decode(bundle.sublist(38)), scope.ownerAttestation);
    expect(length, bundle.length - 38);
  });

  test('a replay keeps the idempotency key', () async {
    final agent = HostedAgentIdentity.fromSecretHex(_agentSecret);
    final scope = scopeFor(agent);
    Future<Map<String, Object?>> build(String id) =>
        buildHostedProvisionRequest(
          requestId: id,
          identity: agent,
          draft: draft,
          scope: scope,
          catalog: catalog,
        );
    final first = await build('a');
    final second = await build('b');
    expect(first['idempotency_key'], second['idempotency_key']);
    expect(first['identity_envelope'], isNot(second['identity_envelope']));
  });

  test(
    'attaches to an existing agent only when the owner picked one',
    () async {
      final agent = HostedAgentIdentity.fromSecretHex(_agentSecret);
      final scope = scopeFor(agent);
      Future<Map<String, Object?>> build(String? kiingoAgentId) =>
          buildHostedProvisionRequest(
            requestId: 'a',
            identity: agent,
            draft: HostedAgentDraft(
              displayName: draft.displayName,
              systemPrompt: draft.systemPrompt,
              providerConfig: draft.providerConfig,
              kiingoAgentId: kiingoAgentId,
            ),
            scope: scope,
            catalog: catalog,
          );
      final fresh = await build(null);
      expect(fresh.containsKey('kiingo_agent_id'), isFalse);
      final attached = await build('0A1B2C3D-0000-4000-8000-00000000ABCD');
      expect(
        attached['kiingo_agent_id'],
        '0a1b2c3d-0000-4000-8000-00000000abcd',
      );
      // Attaching does not change what identifies a replay of the create.
      expect(attached['idempotency_key'], fresh['idempotency_key']);
      await expectLater(
        build('not-a-uuid'),
        throwsA(
          isA<HostedAgentException>().having(
            (e) => e.code,
            'code',
            'kiingo_agent_id_invalid',
          ),
        ),
      );
    },
  );

  test('rejects a model the catalog does not offer before sending', () async {
    final agent = HostedAgentIdentity.fromSecretHex(_agentSecret);
    final provisioner = _FakeProvisioner(const []);
    await expectLater(
      createHostedAgent(
        provisioner: provisioner,
        identity: agent,
        draft: HostedAgentDraft(
          displayName: 'A',
          systemPrompt: '',
          providerConfig: {...draft.providerConfig, 'model_selector': 'nope'},
        ),
        scope: scopeFor(agent),
        catalog: catalog,
      ),
      throwsA(
        isA<HostedAgentException>().having(
          (e) => e.code,
          'code',
          'provider_config_model_unavailable',
        ),
      ),
    );
    expect(provisioner.provisionRequests, isEmpty);
  });

  test('an absent remote needs no replay or delete', () async {
    final agent = HostedAgentIdentity.fromSecretHex(_agentSecret);
    final provisioner = _FakeProvisioner([
      const HostedAgentException('buzz_x_not_linked', remoteAbsent: true),
    ]);
    final failure =
        await createHostedAgent(
          provisioner: provisioner,
          identity: agent,
          draft: draft,
          scope: scopeFor(agent),
          catalog: catalog,
        ).then<HostedCreateFailure?>(
          (_) => null,
          onError: (Object e) => e as HostedCreateFailure,
        );
    expect(failure!.rollback, isA<HostedRollbackRemoved>());
    expect(provisioner.provisionRequests, hasLength(1));
    expect(provisioner.deletedIds, isEmpty);
    expect(agent.isForgotten, isTrue);
  });

  test('an unknown outcome replays once, then deletes', () async {
    final agent = HostedAgentIdentity.fromSecretHex(_agentSecret);
    final provisioner = _FakeProvisioner([
      const HostedAgentException('hosted_agents_timeout'),
      const HostedAgentState(providerAgentId: 'agent-9'),
    ]);
    final failure =
        await createHostedAgent(
          provisioner: provisioner,
          identity: agent,
          draft: draft,
          scope: scopeFor(agent),
          catalog: catalog,
        ).then<HostedCreateFailure?>(
          (_) => null,
          onError: (Object e) => e as HostedCreateFailure,
        );
    expect(failure!.rollback, isA<HostedRollbackRemoved>());
    expect(provisioner.provisionRequests, hasLength(2));
    expect(
      provisioner.provisionRequests[0]['idempotency_key'],
      provisioner.provisionRequests[1]['idempotency_key'],
    );
    expect(
      provisioner.provisionRequests[0]['request_id'],
      isNot(provisioner.provisionRequests[1]['request_id']),
    );
    expect(provisioner.deletedIds, ['agent-9']);
  });

  test(
    'keeps the cleanup when removal is unconfirmed, then finishes',
    () async {
      final agent = HostedAgentIdentity.fromSecretHex(_agentSecret);
      final provisioner = _FakeProvisioner(
        [
          const HostedAgentException('hosted_agents_unreachable'),
          const HostedAgentState(providerAgentId: 'agent-9'),
        ],
        deleteResults: [const HostedAgentException('delete_failed'), null],
      );
      final failure =
          await createHostedAgent(
            provisioner: provisioner,
            identity: agent,
            draft: draft,
            scope: scopeFor(agent),
            catalog: catalog,
          ).then<HostedCreateFailure?>(
            (_) => null,
            onError: (Object e) => e as HostedCreateFailure,
          );
      final kept = failure!.rollback as HostedRollbackKept;
      expect(kept.pending.providerAgentId, 'agent-9');
      expect(agent.isForgotten, isFalse);

      final retried = await rollbackHostedCreate(
        provisioner: provisioner,
        pending: kept.pending,
      );
      expect(retried, isA<HostedRollbackRemoved>());
      // The known id is deleted directly; no further replay.
      expect(provisioner.provisionRequests, hasLength(2));
      expect(provisioner.deletedIds, ['agent-9', 'agent-9']);
      expect(agent.isForgotten, isTrue);
    },
  );

  test('owner proofs carry the exact ordered tags', () {
    final now = DateTime.fromMillisecondsSinceEpoch(1800000000 * 1000);
    final proof = buildDeleteOwnerProof(
      ownerSecretHex: _ownerSecret,
      providerId: 'example',
      requestId: 'req-1',
      providerAgentId: 'agent-9',
      communityId: 'chat.example.test',
      now: now,
    );
    expect(proof['kind'], 27236);
    expect(proof['content'], 'buzz-provider-delete-v1');
    expect(proof['tags'], [
      ['action', 'delete'],
      ['provider', 'example'],
      ['request', 'req-1'],
      ['agent', 'agent-9'],
      ['community', 'chat.example.test'],
      ['expires', '${1800000000 + 300}'],
    ]);
    final preflight = buildPreflightOwnerProof(
      ownerSecretHex: _ownerSecret,
      providerId: 'example',
      requestId: 'req-2',
      communityId: 'chat.example.test',
      now: now,
    );
    expect((preflight['tags'] as List).map((tag) => (tag as List).first), [
      'action',
      'provider',
      'request',
      'community',
      'expires',
    ]);
  });
}
