import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:flutter/foundation.dart';
import 'package:nostr/nostr.dart' as nostr;
import 'package:pointycastle/digests/sha256.dart';

import 'canonical_json.dart';
import 'hosted_agent_errors.dart';

/// Envelope version that carries the key plus the NIP-OA owner attestation.
const hostedIdentityEnvelopeVersion = 2;

const _bundleMagic = [0x4b, 0x42, 0x5a, 0x32]; // "KBZ2"
final _kdfLabel = utf8.encode('kiingo-buzz-identity-v2');
const _maxOwnerAttestationBytes = 512;

/// A freshly generated agent identity that lives only in memory for the
/// duration of one create (and, if needed, its rollback).
///
/// The hosted contract has the creating device generate the agent key and
/// hand it to the API sealed to the API's provisioning key; the phone never
/// writes it to disk or sends it anywhere in the clear. Dart strings cannot be
/// wiped, so [forget] only drops this object's references.
class HostedAgentIdentity {
  HostedAgentIdentity._(this._secretHex, this.publicKey);

  /// Generate a new secp256k1 (BIP-340) agent key.
  factory HostedAgentIdentity.generate() {
    final keys = nostr.Keys.generate();
    return HostedAgentIdentity._(keys.secret, keys.public);
  }

  /// Wrap an existing key (tests only).
  @visibleForTesting
  factory HostedAgentIdentity.fromSecretHex(String secretHex) {
    final keys = nostr.Keys(secretHex);
    return HostedAgentIdentity._(keys.secret, keys.public);
  }

  String? _secretHex;

  /// Lowercase hex x-only public key.
  final String publicKey;

  bool get isForgotten => _secretHex == null;

  String _secret() =>
      _secretHex ?? (throw const HostedAgentException('agent_key_forgotten'));

  /// The key as a bech32 `nsec`, for signing the agent's own NIP-98 header.
  String get nsecForSigning => nostr.Keys(_secret()).nsec;

  /// Sign a Nostr event as the agent.
  Map<String, dynamic> signEvent({
    required int kind,
    required String content,
    required List<List<String>> tags,
  }) => nostr.Event.from(
    kind: kind,
    content: content,
    tags: tags,
    secretKey: _secret(),
    verify: false,
  ).toMap();

  /// The identity bundle sealed into the envelope:
  /// `"KBZ2" || secret(32) || u16be(len(attestation)) || attestation`.
  Uint8List identityBundle(String ownerAttestation) {
    final attestation = utf8.encode(ownerAttestation);
    if (attestation.isEmpty || attestation.length > _maxOwnerAttestationBytes) {
      throw const HostedAgentException('owner_attestation_invalid');
    }
    final secret = hexDecode(_secret());
    if (secret.length != 32) {
      throw const HostedAgentException('agent_private_identity_invalid');
    }
    final bundle = BytesBuilder(copy: false)
      ..add(_bundleMagic)
      ..add(secret)
      ..add([attestation.length >> 8, attestation.length & 0xff])
      ..add(attestation);
    secret.fillRange(0, secret.length, 0);
    return bundle.toBytes();
  }

  /// Drop the secret. Further signing or sealing throws.
  void forget() => _secretHex = null;
}

/// The standard NIP-OA owner attestation, as the compact JSON tag the API and
/// the relay accept: `["auth", <owner>, "", <sig>]` where `sig` is the owner's
/// BIP-340 signature over `sha256("nostr:agent-auth:" + agent + ":")`.
String computeOwnerAttestation({
  required String ownerSecretHex,
  required String agentPublicKey,
}) {
  final owner = nostr.Keys(ownerSecretHex);
  final agent = agentPublicKey.toLowerCase();
  if (owner.public == agent) {
    throw const HostedAgentException('owner_attestation_invalid');
  }
  final digest = SHA256Digest().process(
    Uint8List.fromList(utf8.encode('nostr:agent-auth:$agent:')),
  );
  final signature = owner.sign(message: hexEncode(digest));
  return jsonEncode(['auth', owner.public, '', signature]);
}

/// Associated data bound into the envelope; the API recomputes its hash.
Map<String, Object> identityAssociatedData({
  required String communityId,
  required String relayUrl,
  required String agentPublicKey,
  required String providerConfigSha256,
}) => {
  'community_id': communityId,
  'relay_url': relayUrl,
  'agent_public_key': agentPublicKey,
  'provider_config_sha256': providerConfigSha256,
};

/// Seal [plaintext] to the API's X25519 provisioning key with the same
/// construction as the desktop's bundled provider: an ephemeral X25519 key,
/// `key = sha256(label || shared)`, ChaCha20-Poly1305 with a random 12-byte
/// nonce and the canonical associated data as AAD.
Future<Map<String, Object>> sealHostedIdentity({
  required Uint8List plaintext,
  required String keyId,
  required Uint8List recipientPublicKey,
  required Map<String, Object> associatedData,
  Random? random,
}) async {
  if (recipientPublicKey.length != 32) {
    throw const HostedAgentException('provisioning_key_invalid');
  }
  final x25519 = X25519();
  final ephemeral = await x25519.newKeyPair();
  final ephemeralPublic = await ephemeral.extractPublicKey();
  final shared = await x25519.sharedSecretKey(
    keyPair: ephemeral,
    remotePublicKey: SimplePublicKey(
      recipientPublicKey,
      type: KeyPairType.x25519,
    ),
  );
  final sharedBytes = Uint8List.fromList(await shared.extractBytes());
  final derived = SHA256Digest().process(
    Uint8List.fromList([..._kdfLabel, ...sharedBytes]),
  );
  sharedBytes.fillRange(0, sharedBytes.length, 0);
  final secureRandom = random ?? Random.secure();
  final nonce = Uint8List.fromList(
    List<int>.generate(12, (_) => secureRandom.nextInt(256)),
  );
  final aad = utf8.encode(stableJson(associatedData));
  final box = await Chacha20.poly1305Aead().encrypt(
    plaintext,
    secretKey: SecretKey(derived),
    nonce: nonce,
    aad: aad,
  );
  derived.fillRange(0, derived.length, 0);
  plaintext.fillRange(0, plaintext.length, 0);
  return {
    'version': hostedIdentityEnvelopeVersion,
    'algorithm': 'x25519-chacha20poly1305',
    'key_id': keyId,
    'ephemeral_public_key': base64Encode(ephemeralPublic.bytes),
    'nonce': base64Encode(nonce),
    'ciphertext': base64Encode([...box.cipherText, ...box.mac.bytes]),
    'associated_data_sha256': sha256Hex(aad),
  };
}
