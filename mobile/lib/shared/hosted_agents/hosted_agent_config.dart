import 'package:flutter/foundation.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../relay/relay.dart';

/// Base URL of the hosted-agent provisioning API, baked in at build time with
/// `--dart-define=BUZZ_HOSTED_AGENTS_URL=https://...`. It is the same origin the
/// desktop's bundled provider calls. Empty disables hosted agents on mobile.
const hostedAgentsUrl = String.fromEnvironment('BUZZ_HOSTED_AGENTS_URL');

/// Base64 Ed25519 public key that signs the API's capability catalog
/// (`--dart-define=BUZZ_HOSTED_AGENTS_CATALOG_KEY=...`). The phone accepts a
/// catalog, and the provisioning key the agent identity is encrypted to, only
/// when this pinned key signed it. Empty disables hosted agents.
const hostedAgentsCatalogKey = String.fromEnvironment(
  'BUZZ_HOSTED_AGENTS_CATALOG_KEY',
);

/// Execution location id the API expects in the execution profile
/// (`--dart-define=BUZZ_HOSTED_AGENTS_LOCATION=...`). Empty disables hosted
/// agents.
const hostedAgentsLocation = String.fromEnvironment(
  'BUZZ_HOSTED_AGENTS_LOCATION',
);

/// Relay the hosted API serves. Owner proofs are scoped to its community, so
/// hosted agents are offered only while that community is active. Defaults to
/// the build's `BUZZ_RELAY_URL`.
const hostedAgentsRelayUrl = String.fromEnvironment(
  'BUZZ_HOSTED_AGENTS_RELAY_URL',
  defaultValue: Env.relayUrl,
);

/// Where hosted-agent calls go for the active community.
@immutable
class HostedAgentRoute {
  const HostedAgentRoute({
    required this.baseUrl,
    required this.catalogKey,
    required this.executionLocation,
    required this.communityId,
    required this.relayUrl,
    required this.relayHttpUrl,
  });

  /// Provisioning API base, without a trailing slash.
  final String baseUrl;

  /// Pinned base64 Ed25519 catalog signing key.
  final String catalogKey;

  /// Execution location id sent in the execution profile.
  final String executionLocation;

  /// The active relay's lowercase host (`community` in owner proofs).
  final String communityId;

  /// Normalized `wss://host[:port]` relay URL sent to the API.
  final String relayUrl;

  /// HTTP origin of the relay, for `/events` and `/query`.
  final String relayHttpUrl;
}

bool _acceptableApiUrl(Uri uri) {
  if (uri.scheme == 'https' && uri.host.isNotEmpty) {
    return uri.userInfo.isEmpty && !uri.hasQuery && !uri.hasFragment;
  }
  return kDebugMode &&
      uri.scheme == 'http' &&
      const {'localhost', '127.0.0.1', '::1'}.contains(uri.host);
}

String _hostOf(String url) {
  final uri = Uri.tryParse(url.trim());
  return uri?.host.toLowerCase() ?? '';
}

/// Resolve the route for the active community, or `null` when this build has
/// no hosted API, the configuration is incomplete, or another community is
/// active.
@visibleForTesting
HostedAgentRoute? resolveHostedAgentRoute({
  required String apiUrl,
  required String catalogKey,
  required String executionLocation,
  required String routeRelayUrl,
  required String activeRelayHttpUrl,
}) {
  final trimmed = apiUrl.trim();
  final key = catalogKey.trim();
  final location = executionLocation.trim();
  if (trimmed.isEmpty || key.isEmpty || location.isEmpty) return null;
  final uri = Uri.tryParse(trimmed);
  if (uri == null || !_acceptableApiUrl(uri)) return null;
  final active = Uri.tryParse(activeRelayHttpUrl.trim());
  if (active == null || active.host.isEmpty) return null;
  final communityId = active.host.toLowerCase();
  if (communityId != _hostOf(routeRelayUrl)) return null;
  // The API accepts only TLS relay URLs (`wss://host[:port]`).
  if (active.scheme != 'https') return null;
  final port = active.hasPort ? ':${active.port}' : '';
  return HostedAgentRoute(
    baseUrl: trimmed.replaceAll(RegExp(r'/+$'), ''),
    catalogKey: key,
    executionLocation: location,
    communityId: communityId,
    relayUrl: 'wss://$communityId$port',
    relayHttpUrl: 'https://$communityId$port',
  );
}

/// The hosted-agent route for the active community, or `null` when hosted
/// agents are unavailable in this build or community.
final hostedAgentRouteProvider = Provider<HostedAgentRoute?>((ref) {
  final config = ref.watch(relayConfigProvider);
  return resolveHostedAgentRoute(
    apiUrl: hostedAgentsUrl,
    catalogKey: hostedAgentsCatalogKey,
    executionLocation: hostedAgentsLocation,
    routeRelayUrl: hostedAgentsRelayUrl,
    activeRelayHttpUrl: config.baseUrl,
  );
});
