import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:uuid/uuid.dart';

import '../relay/relay.dart';
import 'guest_approval.dart';

/// Base URL of the hosted guest-access route, baked in at build time with
/// `--dart-define=BUZZ_GUEST_ROUTE_URL=https://...` (the same value desktop
/// builds receive as `BUZZ_BUILD_GUEST_ROUTE_URL`). Empty disables owner
/// review in the app; the Activity inbox still lists the requests.
const guestRouteUrl = String.fromEnvironment('BUZZ_GUEST_ROUTE_URL');

/// Relay the route serves. Owner calls are signed with the community's key,
/// so they are only sent while that community is active. Defaults to the
/// build's `BUZZ_RELAY_URL`.
const guestRouteRelayUrl = String.fromEnvironment(
  'BUZZ_GUEST_ROUTE_RELAY_URL',
  defaultValue: Env.relayUrl,
);

const _requestTimeout = Duration(seconds: 20);
const _maxResponseBytes = 2 * 1024 * 1024;

/// A route error: the contract's `error` code plus the HTTP status, if any.
class GuestAccessException implements Exception {
  const GuestAccessException(this.code, {this.status, this.serverMessage});

  final String code;
  final int? status;
  final String? serverMessage;

  /// Plain-language text for the owner.
  String get message => serverMessage ?? describeGuestAccessError(code);

  @override
  String toString() => 'GuestAccessException($code, $status)';
}

/// Plain-language text for the route's error codes.
String describeGuestAccessError(String code) => switch (code) {
  'guest_route_unavailable' =>
    "Reviewing requests isn't available in this build. Use Buzz on your desktop.",
  'guest_route_unreachable' || 'guest_route_timeout' =>
    "Couldn't reach the guest access service. Check your connection and try again.",
  'owner_not_linked' =>
    'Link your account in Buzz on your desktop to manage guest access for your agents.',
  'approval_already_decided' => 'This request was already decided.',
  'approval_expired' => 'This request expired before it was decided.',
  'approval_not_found' => "This request couldn't be found.",
  'granted_sources_invalid' =>
    'Choose which of the requested sources to share, then approve again.',
  'grantee_not_linked' =>
    "That person hasn't linked their account yet, so a grant can't be created.",
  'nip98_replayed' || 'nip98_expired' =>
    "The request signature expired. Check your phone's clock and try again.",
  'rate_limited' => 'Too many requests. Wait a moment and try again.',
  _ => 'Guest access request failed.',
};

/// Where owner calls go for the active community, or `null` when this build
/// has no route or the active community is not the one the route serves.
@immutable
class GuestAccessRoute {
  const GuestAccessRoute({required this.baseUrl, required this.communityId});

  final String baseUrl;

  /// `X-Buzz-Community`: the active relay's lowercase host.
  final String communityId;
}

/// HTTPS, or HTTP on loopback in debug builds.
bool _acceptableBaseUrl(Uri uri) {
  if (uri.scheme == 'https' && uri.host.isNotEmpty) return true;
  return kDebugMode &&
      uri.scheme == 'http' &&
      const {'localhost', '127.0.0.1', '::1'}.contains(uri.host);
}

String _hostOf(String url) {
  final uri = Uri.tryParse(url.trim());
  return uri?.host.toLowerCase() ?? '';
}

/// Resolve the route for the active community.
@visibleForTesting
GuestAccessRoute? resolveGuestAccessRoute({
  required String routeUrl,
  required String routeRelayUrl,
  required String activeRelayUrl,
}) {
  final trimmed = routeUrl.trim();
  if (trimmed.isEmpty) return null;
  final uri = Uri.tryParse(trimmed);
  if (uri == null || !_acceptableBaseUrl(uri)) return null;
  final communityId = _hostOf(activeRelayUrl);
  if (communityId.isEmpty || communityId != _hostOf(routeRelayUrl)) {
    return null;
  }
  return GuestAccessRoute(
    baseUrl: trimmed.replaceAll(RegExp(r'/+$'), ''),
    communityId: communityId,
  );
}

final guestAccessRouteProvider = Provider<GuestAccessRoute?>((ref) {
  final config = ref.watch(relayConfigProvider);
  return resolveGuestAccessRoute(
    routeUrl: guestRouteUrl,
    routeRelayUrl: guestRouteRelayUrl,
    activeRelayUrl: config.baseUrl,
  );
});

/// Owner-side client for the hosted guest-access route. Every call is
/// authenticated with NIP-98, signed by the owner's own key. Only owner
/// routes are used here; agent routes stay with the harness.
class GuestAccessClient {
  GuestAccessClient({
    required this.route,
    required String? nsec,
    http.Client? httpClient,
  }) : _nsec = nsec,
       _http = httpClient;

  final GuestAccessRoute route;
  final String? _nsec;
  final http.Client? _http;

  Future<Object?> _request(
    String method,
    String path, {
    Map<String, Object?>? body,
  }) async {
    final url = '${route.baseUrl}$path';
    final bytes = body == null ? const <int>[] : utf8.encode(jsonEncode(body));
    final String authorization;
    try {
      authorization = buildNip98AuthHeader(
        method: method,
        url: url,
        bodyBytes: bytes,
        nsec: _nsec,
      );
    } catch (_) {
      throw const GuestAccessException('signing_unavailable');
    }
    final request = http.Request(method, Uri.parse(url))
      ..followRedirects = false
      ..headers['Authorization'] = authorization
      ..headers['X-Buzz-Community'] = route.communityId;
    if (body != null) {
      request.headers['Content-Type'] = 'application/json';
      request.bodyBytes = bytes;
    }
    final client = _http ?? http.Client();
    try {
      final streamed = await client.send(request).timeout(_requestTimeout);
      final response = await http.Response.fromStream(
        streamed,
      ).timeout(_requestTimeout);
      final status = response.statusCode;
      if (response.bodyBytes.length > _maxResponseBytes) {
        throw GuestAccessException('response_too_large', status: status);
      }
      Object? decoded;
      if (response.bodyBytes.isNotEmpty) {
        try {
          decoded = jsonDecode(utf8.decode(response.bodyBytes));
        } catch (_) {
          decoded = null;
        }
      }
      if (status >= 200 && status < 300) return decoded;
      final error = decoded is Map ? decoded['error'] : null;
      final message = decoded is Map ? decoded['message'] : null;
      throw GuestAccessException(
        error is String && error.isNotEmpty ? error : 'http_error',
        status: status,
        serverMessage: message is String && message.isNotEmpty ? message : null,
      );
    } on TimeoutException {
      throw const GuestAccessException('guest_route_timeout');
    } on GuestAccessException {
      rethrow;
    } catch (_) {
      throw const GuestAccessException('guest_route_unreachable');
    } finally {
      if (_http == null) client.close();
    }
  }

  /// One approval by id.
  Future<GuestApproval> approval(String approvalId) async {
    final approval = parseGuestApproval(
      await _request(
        'GET',
        '/owner/approvals/${Uri.encodeComponent(approvalId)}',
      ),
    );
    if (approval == null) {
      throw const GuestAccessException('approval_invalid');
    }
    return approval;
  }

  /// Record a decision. Returns the decided approval when the route sends it.
  Future<GuestApproval?> decide(
    String approvalId, {
    required ApprovalDecision decision,
    String? editedText,
    Map<String, Object>? grant,
    List<String>? grantedSources,
    required String idempotencyKey,
  }) async {
    final approving =
        decision == ApprovalDecision.approve ||
        decision == ApprovalDecision.approveEdited;
    final result = await _request(
      'POST',
      '/owner/approvals/${Uri.encodeComponent(approvalId)}/decision',
      body: {
        'decision': approvalDecisionToWire(decision),
        if (decision == ApprovalDecision.approveEdited)
          'edited_text': editedText ?? '',
        if (approving && grant != null) 'grant': grant,
        if (decision == ApprovalDecision.approve && grantedSources != null)
          'granted_sources': grantedSources,
        'idempotency_key': idempotencyKey,
      },
    );
    return result is Map ? parseGuestApproval(result['approval']) : null;
  }
}

/// A client for the active community, or `null` when owner review is
/// unavailable (no route in this build, another community, or no key).
final guestAccessClientProvider = Provider<GuestAccessClient?>((ref) {
  final route = ref.watch(guestAccessRouteProvider);
  final nsec = ref.watch(relayConfigProvider.select((config) => config.nsec));
  if (route == null || nsec == null || nsec.isEmpty) return null;
  return GuestAccessClient(route: route, nsec: nsec);
});

/// A fresh idempotency key for one approval; reused across retries of the
/// same decision so a retry after a network error is idempotent.
String newDecisionIdempotencyKey(String approvalId) =>
    'mobile:$approvalId:${const Uuid().v4()}';
