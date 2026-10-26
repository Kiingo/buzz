import 'dart:async';
import 'dart:convert';
import 'dart:isolate';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';

import 'nostr_models.dart';
import 'relay_signature_backend.dart';

/// Why the relay session dropped an event it received.
enum RelayEventRejection {
  /// Not a NIP-01 event: a field of the wrong type, or an id, pubkey or
  /// signature that is not lowercase hex of the right length.
  shape,

  /// The id is not the NIP-01 hash of the event's fields: the content, tags,
  /// kind, time or author were changed after the id was computed, or the id
  /// was replaced.
  idMismatch,

  /// The signature is not the author's BIP-340 signature of the id: the
  /// event was forged under someone else's key.
  badSignature,
}

/// Why an event must be dropped, or null when it may be used.
typedef RelayEventCheck = RelayEventRejection? Function(NostrEvent event);

final _hex64 = RegExp(r'^[0-9a-f]{64}$');
final _hex128 = RegExp(r'^[0-9a-f]{128}$');

/// The NIP-01 id of [event]'s fields: the SHA-256 of
/// `[0, pubkey, created_at, kind, tags, content]` serialized as JSON.
String nostrEventId(NostrEvent event) => sha256
    .convert(
      utf8.encode(
        jsonEncode([
          0,
          event.pubkey,
          event.createdAt,
          event.kind,
          event.tags,
          event.content,
        ]),
      ),
    )
    .toString();

/// Why [event] must be dropped at the session boundary, or null when its
/// shape is canonical and its id is the hash of its fields. The relay
/// verifies events on ingest, but the client does not trust what it is
/// served: nothing reaches a provider or cache before this passes.
///
/// The signature is checked separately (it is about 1000 times as costly);
/// see [RelayEventVerifier.verifySignature].
RelayEventRejection? relayEventRejection(NostrEvent event) {
  if (!_hex64.hasMatch(event.id) ||
      !_hex64.hasMatch(event.pubkey) ||
      !_hex128.hasMatch(event.sig) ||
      event.createdAt < 0 ||
      event.kind < 0 ||
      event.kind > 65535) {
    return RelayEventRejection.shape;
  }
  return nostrEventId(event) == event.id
      ? null
      : RelayEventRejection.idMismatch;
}

/// Checks events the relay session receives, on both the HTTP query and
/// socket paths, and counts what it drops by reason. Logs carry only the
/// path, the reason and a well-formed id; never content, tags or keys.
class RelayEventVerifier {
  /// A verifier that drops what [check] rejects and what [signatures]
  /// (by default [platformSignatureBackend]) does not verify.
  RelayEventVerifier({
    this.check = relayEventRejection,
    RelaySignatureBackend? signatures,
  }) : signatures = signatures ?? platformSignatureBackend();

  /// Decides whether an event is dropped, and why. Production sessions use
  /// [relayEventRejection]; only fixtures that model relay ordering with
  /// hand-picked ids pass anything else.
  final RelayEventCheck check;

  /// Checks signatures; only fixtures pass anything but the platform's.
  final RelaySignatureBackend signatures;

  static const _maxVerified = 4096;

  /// Recently verified events, as id + sig + pubkey (fixed-length hex, so
  /// the concatenation is unambiguous), oldest first: a Set literal keeps
  /// insertion order.
  final _verified = <String>{};

  final _rejections = <RelayEventRejection, int>{};

  /// How many events were dropped, by reason, since the session started.
  Map<RelayEventRejection, int> get rejections => Map.unmodifiable(_rejections);

  /// The event [json] from the relay, or null when it must be dropped: it
  /// is not an event, or [check] rejects it. Each drop is counted.
  NostrEvent? admit(Object? json, {required String path}) {
    final (event, rejection, id) = _admit(json, check);
    if (rejection != null) _drop(rejection, id, path);
    return event;
  }

  /// The events of an HTTP answer [body] that [admit] would keep, in order.
  /// Decoding and hashing run on a background isolate, so a long history
  /// page costs the UI isolate nothing; drops are counted here. Throws a
  /// [FormatException] when the body is not a JSON array.
  Future<List<NostrEvent>> admitAnswer(
    String body, {
    required String path,
  }) async {
    final answer = await _admitOnIsolate(body, check);
    for (final (rejection, id) in answer.drops) {
      _drop(rejection, id, path);
    }
    return answer.events;
  }

  /// Whether [event] (already [admit]ted) carries its author's signature of
  /// its id. A bad signature is counted and dropped. Answers synchronously
  /// for a recently verified event and for a synchronous backend.
  FutureOr<bool> verifySignature(NostrEvent event, {required String path}) {
    final key = '${event.id}${event.sig}${event.pubkey}';
    if (_verified.remove(key)) {
      _verified.add(key);
      return true;
    }
    final FutureOr<bool> verdict;
    try {
      verdict = signatures.verify(event.id, event.pubkey, event.sig);
    } catch (_) {
      return _settle(false, key, event.id, path);
    }
    if (verdict is bool) return _settle(verdict, key, event.id, path);
    return verdict.then(
      (valid) => _settle(valid, key, event.id, path),
      onError: (Object _) => _settle(false, key, event.id, path),
    );
  }

  /// The events of [events] (already [admit]ted) whose signatures verify,
  /// in order, once every check has settled. Synchronous checks yield to
  /// the event loop every [_checksPerTurn], so a long page never holds a
  /// frame.
  Future<List<NostrEvent>> verifySignatures(
    List<NostrEvent> events, {
    required String path,
  }) async {
    final verdicts = <FutureOr<bool>>[];
    var synchronous = 0;
    for (final event in events) {
      final verdict = verifySignature(event, path: path);
      verdicts.add(verdict);
      if (verdict is bool && ++synchronous % _checksPerTurn == 0) {
        await Future<void>.delayed(Duration.zero);
      }
    }
    return [
      for (var index = 0; index < events.length; index++)
        if (await verdicts[index]) events[index],
    ];
  }

  static const _checksPerTurn = 32;

  bool _settle(bool valid, String key, String id, String path) {
    if (!valid) {
      _drop(RelayEventRejection.badSignature, id, path);
      return false;
    }
    _verified.add(key);
    if (_verified.length > _maxVerified) _verified.remove(_verified.first);
    return true;
  }

  void _drop(RelayEventRejection rejection, Object? id, String path) {
    _rejections[rejection] = (_rejections[rejection] ?? 0) + 1;
    if (kDebugMode) {
      final shownId = id is String && _hex64.hasMatch(id) ? id : '-';
      debugPrint('relay: dropped event $shownId ($path, ${rejection.name})');
    }
  }
}

/// One payload's verdict: the event, or why it was dropped and its id.
(NostrEvent?, RelayEventRejection?, Object?) _admit(
  Object? json,
  RelayEventCheck check,
) {
  if (json is! Map<String, dynamic>) {
    return (null, RelayEventRejection.shape, null);
  }
  final NostrEvent event;
  try {
    event = NostrEvent.fromJson(json);
  } catch (_) {
    // Whatever the payload throws, it is one bad event, not a failed
    // answer: count it and keep the rest.
    return (null, RelayEventRejection.shape, _idOf(json));
  }
  final rejection = check(event);
  return rejection == null ? (event, null, null) : (null, rejection, event.id);
}

Object? _idOf(Map<String, dynamic> json) {
  try {
    return json['id'];
  } catch (_) {
    return null;
  }
}

// Top-level so the isolate closure captures only the body and the check.
Future<({List<NostrEvent> events, List<(RelayEventRejection, Object?)> drops})>
_admitOnIsolate(String body, RelayEventCheck check) => Isolate.run(() {
  final decoded = jsonDecode(body);
  if (decoded is! List) {
    throw const FormatException('relay returned malformed query response');
  }
  final events = <NostrEvent>[];
  final drops = <(RelayEventRejection, Object?)>[];
  for (final json in decoded) {
    final (event, rejection, id) = _admit(json, check);
    if (event != null) events.add(event);
    if (rejection != null) drops.add((rejection, id is String ? id : null));
  }
  return (events: events, drops: drops);
});
