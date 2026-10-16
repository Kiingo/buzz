import 'package:nostr/nostr.dart' as nostr;

/// Owner proofs for the hosted lifecycle: one-shot kind-27236 events signed
/// by the owner, with an exact ordered tag set and a short expiry. They are
/// byte-for-byte the proofs the desktop signs for its bundled provider
/// (`buzz-provider-preflight-v1`, `buzz-provider-delete-v1`).
const hostedOwnerProofKind = 27236;

/// Lifetime of an owner proof; the API rejects anything longer.
const hostedOwnerProofTtlSeconds = 5 * 60;

Map<String, dynamic> _signProof({
  required String ownerSecretHex,
  required String content,
  required List<List<String>> tags,
  required int createdAt,
}) => nostr.Event.from(
  kind: hostedOwnerProofKind,
  content: content,
  tags: tags,
  secretKey: ownerSecretHex,
  createdAt: createdAt,
  verify: false,
).toMap();

int _nowSeconds(DateTime? now) =>
    (now ?? DateTime.now()).millisecondsSinceEpoch ~/ 1000;

/// Proof for a read-only preflight: `action=preflight`, `provider`,
/// `request`, `community`, `expires`.
Map<String, dynamic> buildPreflightOwnerProof({
  required String ownerSecretHex,
  required String providerId,
  required String requestId,
  required String communityId,
  DateTime? now,
}) {
  final createdAt = _nowSeconds(now);
  return _signProof(
    ownerSecretHex: ownerSecretHex,
    content: 'buzz-provider-preflight-v1',
    createdAt: createdAt,
    tags: [
      ['action', 'preflight'],
      ['provider', providerId],
      ['request', requestId],
      ['community', communityId],
      ['expires', '${createdAt + hostedOwnerProofTtlSeconds}'],
    ],
  );
}

/// Proof for a confirmed delete: `action=delete`, `provider`, `request`,
/// `agent`, `community`, `expires`.
Map<String, dynamic> buildDeleteOwnerProof({
  required String ownerSecretHex,
  required String providerId,
  required String requestId,
  required String providerAgentId,
  required String communityId,
  DateTime? now,
}) {
  final createdAt = _nowSeconds(now);
  return _signProof(
    ownerSecretHex: ownerSecretHex,
    content: 'buzz-provider-delete-v1',
    createdAt: createdAt,
    tags: [
      ['action', 'delete'],
      ['provider', providerId],
      ['request', requestId],
      ['agent', providerAgentId],
      ['community', communityId],
      ['expires', '${createdAt + hostedOwnerProofTtlSeconds}'],
    ],
  );
}
