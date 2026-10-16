import 'dart:async';
import 'dart:convert';

import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:nostr/nostr.dart' as nostr;
import 'package:uuid/uuid.dart';

import '../relay/relay.dart';
import 'hosted_agent_catalog.dart';
import 'hosted_agent_config.dart';
import 'hosted_agent_create_flow.dart';
import 'hosted_agent_errors.dart';
import 'hosted_agent_proofs.dart';
import 'hosted_agent_responses.dart';

const _maxResponseBytes = 2 * 1024 * 1024;

/// Client for the hosted-agent provisioning API: the same four calls the
/// desktop's bundled provider makes (capabilities, preflight, create, confirmed
/// delete). There is no bearer token: create carries the owner's NIP-OA
/// attestation, and preflight and delete carry one-shot owner proofs.
class HostedAgentClient implements HostedAgentProvisioner {
  HostedAgentClient({
    required this.route,
    required String ownerNsec,
    http.Client? httpClient,
  }) : _ownerNsec = ownerNsec,
       _http = httpClient;

  final HostedAgentRoute route;
  final String _ownerNsec;
  final http.Client? _http;

  /// The owner's hex secret, for signing proofs and attestations.
  String ownerSecretHex() {
    try {
      final hex = nostr.Nip19.decode(payload: _ownerNsec).data;
      if (hex.length == 64) return hex;
    } catch (_) {
      // Fall through to the uniform error; never echo the key.
    }
    throw const HostedAgentException('signing_unavailable');
  }

  /// The owner's hex public key.
  String ownerPublicKey() => nostr.Keys(ownerSecretHex()).public;

  Future<(int, Object?)> _send(
    String method,
    String path, {
    Map<String, Object?>? body,
    required Duration timeout,
  }) async {
    final request = http.Request(method, Uri.parse('${route.baseUrl}$path'))
      ..followRedirects = false
      ..headers['Accept'] = 'application/json';
    if (body != null) {
      request.headers['Content-Type'] = 'application/json';
      request.bodyBytes = utf8.encode(jsonEncode(body));
    }
    final client = _http ?? http.Client();
    try {
      final streamed = await client.send(request).timeout(timeout);
      final response = await http.Response.fromStream(
        streamed,
      ).timeout(timeout);
      if (response.bodyBytes.length > _maxResponseBytes) {
        throw HostedAgentException(
          'response_too_large',
          status: response.statusCode,
        );
      }
      Object? decoded;
      if (response.bodyBytes.isNotEmpty) {
        try {
          decoded = jsonDecode(utf8.decode(response.bodyBytes));
        } catch (_) {
          decoded = null;
        }
      }
      return (response.statusCode, decoded);
    } on TimeoutException {
      throw const HostedAgentException('hosted_agents_timeout');
    } on HostedAgentException {
      rethrow;
    } catch (_) {
      throw const HostedAgentException('hosted_agents_unreachable');
    } finally {
      if (_http == null) client.close();
    }
  }

  static bool _ok(int status) => status >= 200 && status < 300;

  /// Fetch and verify the signed capability catalog.
  Future<HostedAgentCatalog> capabilities() async {
    final (status, body) = await _send(
      'GET',
      '/capabilities',
      timeout: const Duration(seconds: 10),
    );
    if (!_ok(status)) {
      throw hostedAgentFailure(
        body,
        status: status,
        fallbackCode: 'capability_api_unreachable',
      );
    }
    return verifyHostedAgentCatalog(
      body,
      pinnedPublicKey: route.catalogKey,
      expectedApiBaseUrl: route.baseUrl,
    );
  }

  /// Read-only owner readiness for [providerConfig]. Creates nothing.
  Future<HostedPreflight> preflight({
    required HostedAgentCatalog catalog,
    required Map<String, Object> providerConfig,
  }) async {
    final requestId = const Uuid().v4();
    final (status, body) = await _send(
      'POST',
      '/preflight',
      timeout: const Duration(seconds: 15),
      body: {
        'contract_version': 1,
        'request_id': requestId,
        'provider_config': providerConfig,
        'owner_proof': buildPreflightOwnerProof(
          ownerSecretHex: ownerSecretHex(),
          providerId: catalog.providerId,
          requestId: requestId,
          communityId: route.communityId,
        ),
      },
    );
    if (!_ok(status)) {
      throw hostedAgentFailure(
        body,
        status: status,
        fallbackCode: 'preflight_failed',
      );
    }
    return parseHostedPreflight(body, requestId);
  }

  /// Create (or idempotently replay) one hosted agent.
  @override
  Future<HostedAgentState> provision(Map<String, Object?> request) async {
    final (status, body) = await _send(
      'POST',
      '/agents',
      timeout: const Duration(seconds: 30),
      body: request,
    );
    if (!_ok(status)) {
      throw hostedAgentFailure(
        body,
        status: status,
        fallbackCode: 'provisioning_failed',
        readAgentState: true,
      );
    }
    return parseHostedAgentState(body);
  }

  /// Delete one hosted agent and wait for the API's terminal confirmation.
  /// Retrying an already deleted agent reports success.
  @override
  Future<void> confirmedDelete({
    required HostedAgentCatalog catalog,
    required String providerAgentId,
  }) async {
    final requestId = const Uuid().v4();
    final (status, body) = await _send(
      'POST',
      '/agents/confirmed-delete',
      timeout: const Duration(seconds: 60),
      body: {
        'contract_version': 1,
        'request_id': requestId,
        'provider_agent_id': providerAgentId,
        'action': 'delete',
        'owner_proof': buildDeleteOwnerProof(
          ownerSecretHex: ownerSecretHex(),
          providerId: catalog.providerId,
          requestId: requestId,
          providerAgentId: providerAgentId,
          communityId: route.communityId,
        ),
      },
    );
    if (!_ok(status)) {
      throw hostedAgentFailure(
        body,
        status: status,
        fallbackCode: 'delete_failed',
      );
    }
    validateConfirmedDelete(
      body,
      requestId: requestId,
      providerAgentId: providerAgentId,
    );
  }
}

/// A client for the active community, or `null` when hosted agents are
/// unavailable (no API in this build, another community, or no key).
final hostedAgentClientProvider = Provider<HostedAgentClient?>((ref) {
  final route = ref.watch(hostedAgentRouteProvider);
  final nsec = ref.watch(relayConfigProvider.select((config) => config.nsec));
  if (route == null || nsec == null || nsec.isEmpty) return null;
  return HostedAgentClient(route: route, ownerNsec: nsec);
});

/// The verified catalog for the active community. Refreshed on demand with
/// `ref.invalidate(hostedAgentCatalogProvider)`.
final hostedAgentCatalogProvider = FutureProvider<HostedAgentCatalog>((
  ref,
) async {
  final client = ref.watch(hostedAgentClientProvider);
  if (client == null) {
    throw const HostedAgentException('hosted_agents_unavailable');
  }
  return client.capabilities();
});
