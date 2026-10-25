/// Surface images and media come only through the Kiingo proxy (§3.1, §10):
/// `GET /api/ui/media?token=<token>` on the host that served the surface.
/// The token is opaque: clients never parse, build or edit it. Any other URL
/// shows its alt text instead.
library;

import 'dart:async';
import 'dart:typed_data';
import 'dart:ui' as ui;

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

/// Most pixels an image may declare in its header (79 S3): a small file
/// that would decode to a huge bitmap shows its alt text instead.
const surfaceMaxImagePixels = 4096 * 4096;

/// Whether an image of [width] x [height] (from its header) is drawn.
bool isDrawableImageSize(int width, int height) =>
    width > 0 && height > 0 && width * height <= surfaceMaxImagePixels;

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

/// The signature expired (401 only): read the surface again (every URL is
/// re-signed) and load once more.
bool isExpiredMediaStatus(int status) => status == 401;

/// What loading a proxied image gave.
sealed class SurfaceImageResult {
  const SurfaceImageResult();
}

/// The checked image bytes and the size its header declares.
class SurfaceImageBytes extends SurfaceImageResult {
  final Uint8List bytes;
  final int width;
  final int height;
  const SurfaceImageBytes(
    this.bytes, {
    required this.width,
    required this.height,
  });
}

/// The URL's signature expired.
class SurfaceImageExpired extends SurfaceImageResult {
  const SurfaceImageExpired();
}

/// Anything else: the alt text shows.
class SurfaceImageFailed extends SurfaceImageResult {
  const SurfaceImageFailed();
}

/// The width and height an encoded image's header declares, read without
/// decoding its pixels; null when the engine can't read it.
Future<({int width, int height})?> readImageHeaderSize(Uint8List bytes) async {
  ui.ImmutableBuffer? buffer;
  ui.ImageDescriptor? descriptor;
  try {
    buffer = await ui.ImmutableBuffer.fromUint8List(bytes);
    descriptor = await ui.ImageDescriptor.encoded(buffer);
    return (width: descriptor.width, height: descriptor.height);
  } catch (error) {
    debugPrint('[Surface] image header unreadable: ${error.runtimeType}');
    return null;
  } finally {
    descriptor?.dispose();
    buffer?.dispose();
  }
}

/// Reads one proxied image: no credentials, no redirects, a raster type,
/// at most [surfaceMaxImageBytes], and at most [surfaceMaxImagePixels] by
/// its header.
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
    final data = bytes.takeBytes();
    final size = await readImageHeaderSize(data);
    if (size == null || !isDrawableImageSize(size.width, size.height)) {
      return const SurfaceImageFailed();
    }
    return SurfaceImageBytes(data, width: size.width, height: size.height);
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
