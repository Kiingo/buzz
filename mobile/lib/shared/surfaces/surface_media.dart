/// Surface images and media come only through the Kiingo proxy (§3.1, §10):
/// `GET /api/ui/media?token=<token>` on the host that served the surface.
/// The token is opaque: clients never parse, build or edit it. Any other URL
/// shows its alt text instead.
library;

import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:http/http.dart' as http;

/// The proxy's path.
const surfaceMediaProxyPath = '/api/ui/media';

/// Raster images only (never SVG, PDF or anything else).
const surfaceImageMimeTypes = {
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/heic',
  'image/webp',
};

/// Largest image read.
const surfaceMaxImageBytes = 10 * 1024 * 1024;

const _timeout = Duration(seconds: 20);
final _token = RegExp(r'^token=[A-Za-z0-9._~-]{1,2048}$');
final _whitespace = RegExp(r'\s');

/// The proxy URL to load, or null. [raw] must be the proxy path with exactly
/// one non-empty `token` and nothing else: relative (`/api/ui/media?token=`)
/// or absolute https on [apiOrigin]'s host and port.
String? proxiedMediaUrl(Object? raw, String apiOrigin) {
  if (raw is! String ||
      raw.isEmpty ||
      raw.length > 2048 ||
      _whitespace.hasMatch(raw) ||
      raw.contains(r'\') ||
      raw.startsWith('//')) {
    return null;
  }
  final api = Uri.tryParse(apiOrigin);
  if (api == null || api.host.isEmpty) return null;
  final url = raw.startsWith('/')
      ? Uri.tryParse('${api.scheme}://${api.authority}$raw')
      : Uri.tryParse(raw);
  if (url == null) return null;
  final sameHost =
      url.host.toLowerCase() == api.host.toLowerCase() && url.port == api.port;
  final schemeOk =
      url.scheme == 'https' || (url.scheme == 'http' && api.scheme == 'http');
  if (!schemeOk ||
      !sameHost ||
      url.userInfo.isNotEmpty ||
      url.hasFragment ||
      url.path != surfaceMediaProxyPath ||
      !_token.hasMatch(url.query)) {
    return null;
  }
  return url.toString();
}

/// The signature expired: read the surface again (every URL is re-signed)
/// and load once more.
bool isExpiredMediaStatus(int status) => status == 401 || status == 410;

/// What loading a proxied image gave.
sealed class SurfaceImageResult {
  const SurfaceImageResult();
}

/// The checked image bytes.
class SurfaceImageBytes extends SurfaceImageResult {
  final Uint8List bytes;
  const SurfaceImageBytes(this.bytes);
}

/// The URL's signature expired.
class SurfaceImageExpired extends SurfaceImageResult {
  const SurfaceImageExpired();
}

/// Anything else: the alt text shows.
class SurfaceImageFailed extends SurfaceImageResult {
  const SurfaceImageFailed();
}

/// Reads one proxied image: no credentials, no redirects, a raster type,
/// at most [surfaceMaxImageBytes].
Future<SurfaceImageResult> loadSurfaceImage(
  String url, {
  http.Client? httpClient,
}) async {
  final client = httpClient ?? http.Client();
  try {
    final request = http.Request('GET', Uri.parse(url))
      ..followRedirects = false
      ..headers['Accept'] = 'image/*';
    final response = await client.send(request).timeout(_timeout);
    if (isExpiredMediaStatus(response.statusCode)) {
      return const SurfaceImageExpired();
    }
    final type = (response.headers['content-type'] ?? '')
        .split(';')
        .first
        .trim()
        .toLowerCase();
    if (response.statusCode != 200 ||
        !surfaceImageMimeTypes.contains(type) ||
        (response.contentLength ?? 0) > surfaceMaxImageBytes) {
      return const SurfaceImageFailed();
    }
    final bytes = BytesBuilder(copy: false);
    await for (final chunk in response.stream.timeout(_timeout)) {
      if (bytes.length + chunk.length > surfaceMaxImageBytes) {
        return const SurfaceImageFailed();
      }
      bytes.add(chunk);
    }
    return SurfaceImageBytes(bytes.takeBytes());
  } catch (error) {
    debugPrint('[Surface] image failed: ${error.runtimeType}');
    return const SurfaceImageFailed();
  } finally {
    if (httpClient == null) client.close();
  }
}

/// One proxied image by its URL (a re-signed URL is a new entry).
final surfaceImageProvider = FutureProvider.autoDispose
    .family<SurfaceImageResult, String>((ref, url) async {
      final keepAlive = ref.keepAlive();
      final expiry = Timer(const Duration(minutes: 5), keepAlive.close);
      ref.onDispose(expiry.cancel);
      return loadSurfaceImage(url);
    });
