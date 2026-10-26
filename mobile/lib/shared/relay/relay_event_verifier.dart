import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:pointycastle/digests/sha256.dart';

import 'nostr_models.dart';

/// Why the relay session dropped an event it received.
enum RelayEventRejection {
  /// Not a NIP-01 event: a field of the wrong type, or an id, pubkey or
  /// signature that is not lowercase hex of the right length.
  shape,

  /// The id is not the NIP-01 hash of the event's fields: the content, tags,
  /// kind, time or author were changed after the id was computed, or the id
  /// was replaced.
  idMismatch,
}

/// Why an event must be dropped, or null when it may be used.
typedef RelayEventCheck = RelayEventRejection? Function(NostrEvent event);

final _hex64 = RegExp(r'^[0-9a-f]{64}$');
final _hex128 = RegExp(r'^[0-9a-f]{128}$');

/// The NIP-01 id of [event]'s fields: the SHA-256 of
/// `[0, pubkey, created_at, kind, tags, content]` serialized as JSON.
String nostrEventId(NostrEvent event) {
  final serialized = utf8.encode(
    jsonEncode([
      0,
      event.pubkey,
      event.createdAt,
      event.kind,
      event.tags,
      event.content,
    ]),
  );
  final digest = SHA256Digest().process(Uint8List.fromList(serialized));
  final out = StringBuffer();
  for (final byte in digest) {
    out.write(byte.toRadixString(16).padLeft(2, '0'));
  }
  return out.toString();
}

/// Why [event] must be dropped at the session boundary, or null when its
/// shape is canonical and its id is the hash of its fields. The relay
/// verifies events on ingest, but the client does not trust what it is
/// served: nothing reaches a provider or cache before this passes.
///
/// The signature is checked separately (it is about 1000 times as costly).
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
  /// A verifier that drops what [check] rejects.
  RelayEventVerifier({this.check = relayEventRejection});

  /// Decides whether an event is dropped, and why. Production sessions use
  /// [relayEventRejection]; only fixtures that model relay ordering with
  /// hand-picked ids pass anything else.
  final RelayEventCheck check;

  final _rejections = <RelayEventRejection, int>{};

  /// How many events were dropped, by reason, since the session started.
  Map<RelayEventRejection, int> get rejections => Map.unmodifiable(_rejections);

  /// The event [json] from the relay, or null when it must be dropped: it
  /// is not an event, or [check] rejects it. Each drop is counted.
  NostrEvent? admit(Object? json, {required String path}) {
    final event = _parse(json, path);
    if (event == null) return null;
    final rejection = check(event);
    if (rejection == null) return event;
    _drop(rejection, event.id, path);
    return null;
  }

  NostrEvent? _parse(Object? json, String path) {
    if (json is! Map<String, dynamic>) {
      _drop(RelayEventRejection.shape, null, path);
      return null;
    }
    try {
      return NostrEvent.fromJson(json);
    } catch (_) {
      // Whatever the payload throws, it is one bad event, not a failed
      // answer: count it and keep the rest.
      _drop(RelayEventRejection.shape, _idOf(json), path);
      return null;
    }
  }

  static Object? _idOf(Map<String, dynamic> json) {
    try {
      return json['id'];
    } catch (_) {
      return null;
    }
  }

  void _drop(RelayEventRejection rejection, Object? id, String path) {
    _rejections[rejection] = (_rejections[rejection] ?? 0) + 1;
    if (kDebugMode) {
      final shownId = id is String && _hex64.hasMatch(id) ? id : '-';
      debugPrint('relay: dropped event $shownId ($path, ${rejection.name})');
    }
  }
}
