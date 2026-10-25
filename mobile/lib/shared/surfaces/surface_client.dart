import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:http/http.dart' as http;

import '../guest_access/guest_access_client.dart';
import '../relay/relay.dart';
import 'surface_model.dart';

const _requestTimeout = Duration(seconds: 20);
const _maxResponseBytes = 2 * 1024 * 1024;

/// The host's surface routes for this app.
const surfaceRouteMount = '/api/buzz-ui/ios';

/// How long a read surface is reused while its message scrolls in and out.
const surfaceCacheTtl = Duration(minutes: 2);

final _uuid = RegExp(
  r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
);

/// A surface as this person may see it, with the host it came from (its
/// images load from there).
@immutable
class LoadedSurface {
  final Surface surface;

  /// The host's origin, such as `https://api.kiingo.com`.
  final String origin;

  const LoadedSurface({required this.surface, required this.origin});
}

/// Reads surfaces from the agent host with a NIP-98 GET signed by the
/// reader's key. View only: this client has no write route.
class SurfaceClient {
  SurfaceClient({
    required this.route,
    required String nsec,
    http.Client? httpClient,
  }) : _nsec = nsec,
       _http = httpClient;

  final GuestAccessRoute route;
  final String _nsec;
  final http.Client? _http;

  /// The host origin of the guest route, or null when it isn't one.
  String? get origin {
    final uri = Uri.tryParse(route.baseUrl);
    if (uri == null || uri.host.isEmpty) return null;
    return uri.origin;
  }

  /// The surface [id], or null when the host has none for this person (not
  /// found, not theirs, or not a surface).
  Future<LoadedSurface?> fetch(String id) async {
    final host = origin;
    final surfaceId = id.toLowerCase();
    if (host == null || !_uuid.hasMatch(surfaceId)) return null;
    final url = '$host$surfaceRouteMount/surfaces/$surfaceId';
    final request = http.Request('GET', Uri.parse(url))
      ..followRedirects = false
      ..headers['Accept'] = 'application/json'
      ..headers['Authorization'] = buildNip98AuthHeader(
        method: 'GET',
        url: url,
        bodyBytes: const [],
        nsec: _nsec,
      )
      ..headers['X-Buzz-Community'] = route.communityId;
    final client = _http ?? http.Client();
    try {
      final response = await client.send(request).timeout(_requestTimeout);
      if (response.statusCode == 403 || response.statusCode == 404) {
        return null;
      }
      if (response.statusCode != 200 ||
          (response.contentLength ?? 0) > _maxResponseBytes) {
        throw StateError('surface_${response.statusCode}');
      }
      final bytes = BytesBuilder(copy: false);
      await for (final chunk in response.stream.timeout(_requestTimeout)) {
        if (bytes.length + chunk.length > _maxResponseBytes) {
          throw StateError('surface_too_large');
        }
        bytes.add(chunk);
      }
      final surface = decodeSurface(jsonDecode(utf8.decode(bytes.takeBytes())));
      if (surface == null || surface.id.toLowerCase() != surfaceId) {
        return null;
      }
      return LoadedSurface(surface: surface, origin: host);
    } finally {
      if (_http == null) client.close();
    }
  }
}

/// The reader's surface client, or null when this build has no hosted route
/// for the active community. A community switch makes a new one.
final surfaceClientProvider = Provider<SurfaceClient?>((ref) {
  final route = ref.watch(guestAccessRouteProvider);
  final nsec = ref.watch(relayConfigProvider.select((config) => config.nsec));
  if (route == null || nsec == null || nsec.isEmpty) return null;
  return SurfaceClient(route: route, nsec: nsec);
});

/// One surface by id and the revision its message named. Null while the
/// host has none for this person, or on any failure: the message then shows
/// as its text.
final agentSurfaceProvider = FutureProvider.autoDispose
    .family<LoadedSurface?, ({String id, int revision})>((ref, key) async {
      final client = ref.watch(surfaceClientProvider);
      if (client == null) return null;
      final keepAlive = ref.keepAlive();
      final expiry = Timer(surfaceCacheTtl, keepAlive.close);
      ref.onDispose(expiry.cancel);
      try {
        return await client.fetch(key.id);
      } catch (error) {
        debugPrint(
          '[Surface] read failed: '
          '${error is StateError ? error.message : error.runtimeType}',
        );
        return null;
      }
    });
