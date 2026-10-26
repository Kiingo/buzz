import 'dart:async';

import 'package:buzz/shared/auth/auth_provider.dart';
import 'package:buzz/shared/relay/nostr_models.dart';
import 'package:buzz/shared/relay/relay_event_verifier.dart';
import 'package:buzz/shared/relay/relay_signature_backend.dart';
import 'package:nostr/nostr.dart' as nostr;

/// An event shaped the way the relay serves it: lowercase hex author and
/// signature, and the NIP-01 id of its fields, so it passes the session's
/// shape and id checks. The signature bytes are placeholders, so it passes
/// the signature check only with [trustingSignatures]. Pass [id] only to
/// model a forged or replaced id.
NostrEvent servedEvent({
  required int kind,
  List<List<String>> tags = const [],
  String content = '',
  int createdAt = 1,
  String? id,
}) {
  final event = NostrEvent(
    id: '',
    pubkey: _placeholderAuthor,
    createdAt: createdAt,
    kind: kind,
    tags: tags,
    content: content,
    sig: _placeholderSignature,
  );
  return _withId(event, id ?? nostrEventId(event));
}

/// An event signed for real by [secretKey] (by default a fixture key), so
/// it passes every check. Pass [id] only to model a forged or replaced id.
NostrEvent signedEvent({
  required int kind,
  List<List<String>> tags = const [],
  String content = '',
  int createdAt = 1,
  String secretKey = fixtureSecretKey,
  String? id,
}) {
  final signed = nostr.Event.from(
    kind: kind,
    tags: tags,
    content: content,
    createdAt: createdAt,
    secretKey: secretKey,
  );
  return _withId(
    NostrEvent(
      id: signed.id,
      pubkey: signed.pubkey,
      createdAt: signed.createdAt,
      kind: signed.kind,
      tags: signed.tags,
      content: signed.content,
      sig: signed.sig,
    ),
    id ?? signed.id,
  );
}

/// The fixture author's secret key. Test-only; it guards nothing.
const fixtureSecretKey =
    '0000000000000000000000000000000000000000000000000000000000000003';

/// A second fixture author, for events forged under another key.
const otherSecretKey =
    'b7e151628aed2a6abf7158809cf4f3c762e7160f38b4da56a784d9045190cfef';

/// Verifies for real, synchronously, so tests that drive the session
/// message by message see each event applied at once.
const RelaySignatureBackend verifyingNow = _VerifyingNow();

/// Accepts every signature, for fixtures whose events carry placeholder or
/// hand-picked fields; the signature check is covered elsewhere.
const RelaySignatureBackend trustingSignatures = _Trusting();

class _VerifyingNow implements RelaySignatureBackend {
  const _VerifyingNow();

  @override
  FutureOr<bool> verify(String id, String pubkey, String sig) =>
      verifyBip340(id, pubkey, sig);
}

class _Trusting implements RelaySignatureBackend {
  const _Trusting();

  @override
  FutureOr<bool> verify(String id, String pubkey, String sig) => true;
}

/// Holds authentication steady, so HTTP transport tests avoid unrelated
/// native storage initialization and provider retirement mid-query.
class PendingAuthNotifier extends AuthNotifier {
  @override
  Future<AuthState> build() => Completer<AuthState>().future;
}

NostrEvent _withId(NostrEvent event, String id) => NostrEvent(
  id: id,
  pubkey: event.pubkey,
  createdAt: event.createdAt,
  kind: event.kind,
  tags: event.tags,
  content: event.content,
  sig: event.sig,
);

const _placeholderAuthor =
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
final _placeholderSignature = 'b' * 128;
