import 'package:buzz/shared/relay/nostr_models.dart';
import 'package:buzz/shared/relay/relay_event_verifier.dart';

/// An event shaped the way the relay serves it: lowercase hex author and
/// signature, and the NIP-01 id of its fields, so it passes the session's
/// boundary checks. The signature bytes are placeholders. Pass [id] only to
/// model a forged or replaced id.
NostrEvent servedEvent({
  required int kind,
  List<List<String>> tags = const [],
  String content = '',
  int createdAt = 1,
  String pubkey = _author,
  String? id,
}) {
  final event = NostrEvent(
    id: '',
    pubkey: pubkey,
    createdAt: createdAt,
    kind: kind,
    tags: tags,
    content: content,
    sig: _signature,
  );
  return NostrEvent(
    id: id ?? nostrEventId(event),
    pubkey: pubkey,
    createdAt: createdAt,
    kind: kind,
    tags: tags,
    content: content,
    sig: _signature,
  );
}

const _author =
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
final _signature = 'b' * 128;
