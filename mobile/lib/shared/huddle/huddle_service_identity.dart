import 'dart:convert';

import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:http/http.dart' as http;

import '../relay/relay_provider.dart';

const _lookupTimeout = Duration(seconds: 8);
const _maximumDocumentBytes = 512 * 1024;

/// Reads the relay's advertised huddle service identities from a NIP-11
/// document: lowercase 64-character hex pubkeys, ignoring anything else.
Set<String> parseHuddleServicePubkeys(Object? document) {
  if (document is! Map) return const {};
  final values = document['huddle_service_pubkeys'];
  if (values is! List) return const {};
  final keys = <String>{};
  for (final value in values) {
    if (value is! String) continue;
    final key = value.trim().toLowerCase();
    if (RegExp(r'^[0-9a-f]{64}$').hasMatch(key)) keys.add(key);
  }
  return Set.unmodifiable(keys);
}

/// Whether [signerPubkey] is one of the relay's huddle service identities.
///
/// Service-signed huddle notices render as system notices rather than as a
/// person, because the service is not a member anyone can open a profile for.
bool isHuddleServiceSigner(String? signerPubkey, Set<String> services) {
  final key = signerPubkey?.trim().toLowerCase();
  return key != null && key.isNotEmpty && services.contains(key);
}

/// Supplies the unauthenticated client for the public NIP-11 document.
final huddleServiceHttpClientProvider = Provider<http.Client>((ref) {
  final client = http.Client();
  ref.onDispose(client.close);
  return client;
});

/// The active relay's huddle service identities, from its NIP-11 document.
///
/// A failed lookup stays an error (Riverpod retries it with backoff) instead
/// of becoming an authoritative empty set; consumers fall back to rendering
/// the signer as usual until the document loads.
final huddleServicePubkeysProvider = FutureProvider<Set<String>>((ref) async {
  final baseUrl = ref.watch(relayConfigProvider.select((c) => c.baseUrl));
  final uri = Uri.tryParse(baseUrl);
  if (uri == null ||
      !const {'http', 'https'}.contains(uri.scheme) ||
      uri.host.isEmpty) {
    return const {};
  }
  final client = ref.read(huddleServiceHttpClientProvider);
  final response = await client
      .get(
        uri.resolve('/'),
        headers: const {'Accept': 'application/nostr+json'},
      )
      .timeout(_lookupTimeout);
  if (response.statusCode != 200) {
    throw StateError('NIP-11 request failed with HTTP ${response.statusCode}');
  }
  if (response.bodyBytes.length > _maximumDocumentBytes) {
    throw StateError('NIP-11 document is too large');
  }
  return parseHuddleServicePubkeys(jsonDecode(utf8.decode(response.bodyBytes)));
});
