import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import '../relay/relay.dart';
import 'hosted_agent_identity.dart';

/// Kind of the owner-signed managed-agent record (NIP-AP).
const managedAgentEventKind = 30177;

/// Kind of a NIP-IA identity archive request.
const identityArchiveRequestKind = 9035;

/// New agents start with the desktop's default parallelism.
const _defaultAgentParallelism = 10;

/// Publishes a hosted agent's Buzz identity the same way the desktop does:
/// the agent's own kind:0 profile carrying the owner's NIP-OA tag, and the
/// owner's kind:30177 managed-agent record. Delete retires both.
class HostedAgentRelayPublisher {
  HostedAgentRelayPublisher({
    required this.relayHttpUrl,
    required SignedEventRelay ownerRelay,
    http.Client? httpClient,
  }) : _ownerRelay = ownerRelay,
       _http = httpClient;

  /// HTTP origin of the relay.
  final String relayHttpUrl;
  final SignedEventRelay _ownerRelay;
  final http.Client? _http;

  /// Publish the agent-signed kind:0 profile through `POST /events`, signed
  /// with the agent's own NIP-98 header plus `x-auth-tag`, so the relay admits
  /// the not-yet-member agent on the owner's attestation.
  Future<void> publishAgentProfile({
    required HostedAgentIdentity identity,
    required String displayName,
    required String ownerAttestation,
  }) async {
    final authTag = (jsonDecode(ownerAttestation) as List).cast<String>();
    final event = identity.signEvent(
      kind: EventKind.profile,
      content: jsonEncode({'display_name': displayName}),
      tags: [authTag],
    );
    final url = '${relayHttpUrl.replaceAll(RegExp(r'/+$'), '')}/events';
    final body = utf8.encode(jsonEncode(event));
    final authorization = buildNip98AuthHeader(
      method: 'POST',
      url: url,
      bodyBytes: body,
      nsec: identity.nsecForSigning,
    );
    final client = _http ?? http.Client();
    try {
      final response = await client
          .post(
            Uri.parse(url),
            headers: {
              'Authorization': authorization,
              'Content-Type': 'application/json',
              'x-auth-tag': ownerAttestation,
            },
            body: body,
          )
          .timeout(const Duration(seconds: 15));
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw Exception(
          "Couldn't publish the agent's profile (${response.statusCode}).",
        );
      }
    } on TimeoutException {
      throw Exception("Couldn't publish the agent's profile (timed out).");
    } finally {
      if (_http == null) client.close();
    }
  }

  /// Publish the owner's definition-less managed-agent record (kind:30177,
  /// `d` = agent pubkey). Its content is the desktop's public projection;
  /// nothing secret and no provider configuration leaves the phone.
  Future<void> publishManagedAgent({
    required String agentPublicKey,
    required String displayName,
    required String systemPrompt,
  }) async {
    final prompt = systemPrompt.trim();
    await _ownerRelay.submit(
      kind: managedAgentEventKind,
      content: jsonEncode({
        'name': displayName,
        if (prompt.isNotEmpty) 'system_prompt': prompt,
        'parallelism': _defaultAgentParallelism,
        'respond_to': 'owner-only',
      }),
      tags: [
        ['d', agentPublicKey],
      ],
    );
  }

  /// After a confirmed delete: tombstone the managed-agent record (NIP-09)
  /// and ask the relay to archive the identity (NIP-IA `retired`), as the
  /// desktop does. [ownerAttestation] is a fresh owner tag for the agent.
  Future<void> retireAgent({
    required String ownerPublicKey,
    required String agentPublicKey,
    required String ownerAttestation,
  }) async {
    await _ownerRelay.submit(
      kind: EventKind.deletion,
      content: '',
      tags: [
        ['a', '$managedAgentEventKind:$ownerPublicKey:$agentPublicKey'],
      ],
    );
    final authTag = (jsonDecode(ownerAttestation) as List).cast<String>();
    await _ownerRelay.submit(
      kind: identityArchiveRequestKind,
      content: '',
      tags: [
        ['-'],
        ['p', agentPublicKey.toLowerCase()],
        ['reason', 'retired'],
        authTag,
      ],
    );
  }
}
