import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:http/http.dart' as http;

import '../guest_access/guest_access_client.dart';
import '../relay/relay.dart';

/// How long one DM-open prewarm request is not repeated for an agent.
const agentDmPrewarmDebounce = Duration(minutes: 2);

const _requestTimeout = Duration(seconds: 10);

/// Asks the hosted route to warm the agent's session for the reader when a
/// 1:1 agent DM opens, so the first reply starts sooner. Fire and forget:
/// the server always answers 200 and decides whether anything happens.
Future<void> requestAgentDmPrewarm({
  required GuestAccessRoute route,
  required String nsec,
  required String agentPublicKey,
  http.Client? httpClient,
}) async {
  final url =
      '${route.baseUrl}/agents/${Uri.encodeComponent(agentPublicKey)}/prewarm';
  final request = http.Request('POST', Uri.parse(url))
    ..followRedirects = false
    ..headers['Authorization'] = buildNip98AuthHeader(
      method: 'POST',
      url: url,
      bodyBytes: const [],
      nsec: nsec,
    )
    ..headers['X-Buzz-Community'] = route.communityId;
  final client = httpClient ?? http.Client();
  try {
    final streamed = await client.send(request).timeout(_requestTimeout);
    await streamed.stream.drain<void>().timeout(_requestTimeout);
  } finally {
    if (httpClient == null) client.close();
  }
}

/// Prewarms the agent with this lowercase key once per
/// [agentDmPrewarmDebounce] while a DM watches it. Any failure is ignored:
/// a missed prewarm only means the first reply starts cold.
final agentDmPrewarmProvider = FutureProvider.autoDispose.family<void, String>((
  ref,
  agentPublicKey,
) async {
  final route = ref.watch(guestAccessRouteProvider);
  final nsec = ref.watch(relayConfigProvider.select((config) => config.nsec));
  if (route == null || nsec == null || nsec.isEmpty) return;
  final keepAlive = ref.keepAlive();
  final expiry = Timer(agentDmPrewarmDebounce, keepAlive.close);
  ref.onDispose(expiry.cancel);
  try {
    await requestAgentDmPrewarm(
      route: route,
      nsec: nsec,
      agentPublicKey: agentPublicKey.toLowerCase(),
    );
  } catch (error) {
    debugPrint('[AgentDmPrewarm] request failed: $error');
  }
});
