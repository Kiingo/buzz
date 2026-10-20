import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import 'hosted_agent_client.dart';
import 'hosted_agent_errors.dart';

/// How long a "session controls are on" answer is reused.
const sessionControlsOnTtl = Duration(minutes: 10);

/// How long an "off" answer, or a failed check, is reused. A failure is
/// treated as off and not retried before this.
const sessionControlsOffTtl = Duration(minutes: 2);

/// Reads the `POST /session-controls` answer for [requestId] and
/// [agentPublicKey]. Anything other than the exact contract shape throws.
bool parseSessionControlsResponse(
  Object? body, {
  required String requestId,
  required String agentPublicKey,
}) {
  if (body is Map &&
      body['contract_version'] == 1 &&
      body['correlation_id'] == requestId &&
      body['agent_public_key'] == agentPublicKey) {
    final value = body['session_controls'];
    if (value is bool) return value;
  }
  throw const HostedAgentException('session_controls_malformed');
}

/// Asks whether session controls are on for one agent key. `null` when this
/// build or community has no hosted API.
typedef SessionControlsLookup = Future<bool> Function(String agentPublicKey);

/// The lookup for the active community and signed-in key, or `null` when
/// hosted agents are unavailable here.
final sessionControlsLookupProvider = Provider<SessionControlsLookup?>((ref) {
  final client = ref.watch(hostedAgentClientProvider);
  if (client == null) return null;
  return (agentPublicKey) async {
    final catalog = await ref.read(hostedAgentCatalogProvider.future);
    return client.sessionControls(
      catalog: catalog,
      agentPublicKey: agentPublicKey,
    );
  };
});

/// Whether the server has session controls on for the agent with this
/// lowercase public key. Asked lazily, the first time an agent DM watches it,
/// and cached per key: [sessionControlsOnTtl] when on, [sessionControlsOffTtl]
/// when off. Any error or timeout is off (fail closed) and is not retried
/// until that cache lapses and a DM asks again.
final agentSessionControlsProvider = FutureProvider.autoDispose
    .family<bool, String>((ref, agentPublicKey) async {
      final lookup = ref.watch(sessionControlsLookupProvider);
      if (lookup == null) return false;
      final keepAlive = ref.keepAlive();
      var available = false;
      try {
        available = await lookup(agentPublicKey.toLowerCase());
      } catch (error) {
        debugPrint('[SessionControls] check failed: $error');
      }
      final expiry = Timer(
        available ? sessionControlsOnTtl : sessionControlsOffTtl,
        keepAlive.close,
      );
      ref.onDispose(expiry.cancel);
      return available;
    });
