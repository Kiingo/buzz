import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:http/http.dart' as http;

import '../guest_access/guest_access_client.dart';
import '../relay/relay.dart';

const _requestTimeout = Duration(seconds: 20);
const _maxResponseBytes = 512 * 1024;

/// How long one agent's summary is reused while its details page reopens.
const agentSummaryTtl = Duration(minutes: 2);

String? _text(Object? value) =>
    value is String && value.trim().isNotEmpty ? value.trim() : null;

int? _int(Object? value) => value is int ? value : null;

/// What runs this agent: its primary harness, model and effort, and the
/// model it resolves to for the reader (hosted turns use the sender's own
/// subscription).
@immutable
class AgentSummaryExecution {
  const AgentSummaryExecution({
    required this.harness,
    required this.model,
    required this.effort,
    required this.pinned,
    this.resolvedModel,
    this.resolvedEffort,
    this.unavailableReason,
  });

  final String harness;
  final String model;
  final String effort;
  final bool pinned;
  final String? resolvedModel;
  final String? resolvedEffort;
  final String? unavailableReason;
}

/// The reader's current session with this agent.
@immutable
class AgentSummarySession {
  const AgentSummarySession({
    required this.sessionId,
    required this.harness,
    this.title,
    required this.turnCount,
    this.lastActivityAt,
  });

  final String sessionId;
  final String harness;
  final String? title;
  final int turnCount;
  final DateTime? lastActivityAt;
}

/// The agent details page, from the hosted route's
/// `GET /agents/{key}/summary`.
@immutable
class AgentSummary {
  const AgentSummary({
    required this.name,
    this.description,
    required this.status,
    this.ownerName,
    required this.ownerIsOrganization,
    this.execution,
    required this.runsOnMachine,
    this.machineName,
    this.session,
    required this.sessionControls,
    required this.skills,
    this.toolTrust,
    this.editUrl,
  });

  final String name;
  final String? description;
  final String status;
  final String? ownerName;
  final bool ownerIsOrganization;
  final AgentSummaryExecution? execution;
  final bool runsOnMachine;
  final String? machineName;
  final AgentSummarySession? session;
  final bool sessionControls;

  /// Skill names the agent can use.
  final List<String> skills;

  /// `standard` or `full`, or `null` when tool access is unknown.
  final String? toolTrust;

  /// Where an owner or admin edits the agent, if the reader may.
  final Uri? editUrl;
}

/// The summary in [body] for [agentPublicKey], or `null` when the body is not
/// that contract.
AgentSummary? parseAgentSummary(
  Object? body, {
  required String agentPublicKey,
}) {
  if (body is! Map ||
      body['contract_version'] != 1 ||
      body['agent_public_key'] != agentPublicKey) {
    return null;
  }
  final agent = body['agent'];
  if (agent is! Map) return null;
  final name = _text(agent['name']);
  if (name == null) return null;
  final owner = body['owner'] is Map ? body['owner'] as Map : const {};
  final execution = body['execution'];
  final location = body['location'] is Map ? body['location'] as Map : const {};
  final session = body['viewer_session'];
  final tools = body['tools'];
  final editUrl = Uri.tryParse(_text(body['edit_url']) ?? '');
  return AgentSummary(
    name: name,
    description: _text(agent['description']),
    status: _text(agent['status']) ?? 'enabled',
    ownerName: _text(owner['display_name']),
    ownerIsOrganization: owner['principal_type'] == 'Organization',
    execution: execution is Map && _text(execution['harness']) != null
        ? AgentSummaryExecution(
            harness: _text(execution['harness'])!,
            model: _text(execution['model']) ?? 'default',
            effort: _text(execution['effort']) ?? 'auto',
            pinned: execution['pinned'] == true,
            resolvedModel: _text(execution['resolved_model']),
            resolvedEffort: _text(execution['resolved_effort']),
            unavailableReason: _text(execution['unavailable_reason']),
          )
        : null,
    runsOnMachine: location['kind'] == 'machine',
    machineName: _text(location['machine_name']),
    session: session is Map && _text(session['session_id']) != null
        ? AgentSummarySession(
            sessionId: _text(session['session_id'])!,
            harness: _text(session['harness']) ?? '',
            title: _text(session['title']),
            turnCount: _int(session['turn_count']) ?? 0,
            lastActivityAt: DateTime.tryParse(
              _text(session['last_activity_at']) ?? '',
            ),
          )
        : null,
    sessionControls: body['session_controls'] == true,
    skills: [
      if (body['skills'] is List)
        for (final skill in body['skills'] as List)
          if (skill is Map && _text(skill['name']) != null)
            _text(skill['name'])!,
    ],
    toolTrust: tools is Map ? _text(tools['execution_trust']) : null,
    editUrl: editUrl != null && editUrl.scheme == 'https' ? editUrl : null,
  );
}

/// Reads one agent's summary with a NIP-98 GET signed by the reader's key.
class AgentSummaryClient {
  AgentSummaryClient({
    required this.route,
    required String nsec,
    http.Client? httpClient,
  }) : _nsec = nsec,
       _http = httpClient;

  final GuestAccessRoute route;
  final String _nsec;
  final http.Client? _http;

  Future<AgentSummary> fetch(String agentPublicKey) async {
    final url =
        '${route.baseUrl}/agents/${Uri.encodeComponent(agentPublicKey)}/summary';
    final request = http.Request('GET', Uri.parse(url))
      ..followRedirects = false
      ..headers['Authorization'] = buildNip98AuthHeader(
        method: 'GET',
        url: url,
        bodyBytes: const [],
        nsec: _nsec,
      )
      ..headers['X-Buzz-Community'] = route.communityId;
    final client = _http ?? http.Client();
    try {
      final streamed = await client.send(request).timeout(_requestTimeout);
      final response = await http.Response.fromStream(
        streamed,
      ).timeout(_requestTimeout);
      if (response.statusCode != 200 ||
          response.bodyBytes.length > _maxResponseBytes) {
        throw StateError('agent_summary_${response.statusCode}');
      }
      final summary = parseAgentSummary(
        jsonDecode(utf8.decode(response.bodyBytes)),
        agentPublicKey: agentPublicKey,
      );
      if (summary == null) throw StateError('agent_summary_malformed');
      return summary;
    } finally {
      if (_http == null) client.close();
    }
  }
}

final agentSummaryClientProvider = Provider<AgentSummaryClient?>((ref) {
  final route = ref.watch(guestAccessRouteProvider);
  final nsec = ref.watch(relayConfigProvider.select((config) => config.nsec));
  if (route == null || nsec == null || nsec.isEmpty) return null;
  return AgentSummaryClient(route: route, nsec: nsec);
});

/// The details of the agent with this lowercase key, or `null` when this
/// build has no hosted route or the server has none to show (not linked, not
/// visible, or any failure): the page then simply has no agent section.
final agentSummaryProvider = FutureProvider.autoDispose
    .family<AgentSummary?, String>((ref, agentPublicKey) async {
      final client = ref.watch(agentSummaryClientProvider);
      if (client == null) return null;
      final keepAlive = ref.keepAlive();
      final expiry = Timer(agentSummaryTtl, keepAlive.close);
      ref.onDispose(expiry.cancel);
      try {
        return await client.fetch(agentPublicKey.toLowerCase());
      } catch (error) {
        debugPrint('[AgentSummary] fetch failed: $error');
        return null;
      }
    });
