import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:uuid/uuid.dart';

import '../../shared/guest_access/guest_access_client.dart';
import '../../shared/relay/relay.dart';
import 'agent_call_feed.dart';

/// The agent host's call routes for this app (`<origin>/api/buzz-voice/ios`),
/// every request NIP-98 signed by the signed-in user (exact URL with query,
/// method, and the SHA-256 of the exact body bytes) with `X-Buzz-Community`.
/// The host starts a call only from the caller's private 1:1 DM with the
/// agent and serves each call to its caller only.
const agentCallMount = '/api/buzz-voice/ios';

/// The feed long-poll waits up to 20 s on the host.
const _requestTimeout = Duration(seconds: 35);

class AgentCallApiException implements Exception {
  const AgentCallApiException(this.status, this.code);

  final int? status;
  final String? code;

  @override
  String toString() => 'AgentCallApiException($status, $code)';
}

class AgentCallStart {
  const AgentCallStart({
    required this.callId,
    required this.sdpAnswer,
    required this.executeUntil,
  });

  final String callId;
  final String sdpAnswer;
  final DateTime? executeUntil;
}

enum AgentCallStopOutcome { stopped, nothingToStop }

String newAgentCallIdempotencyKey() => const Uuid().v4();

/// The call routes' origin: the guest route's origin (same host).
String? agentCallOrigin(GuestAccessRoute route) {
  final uri = Uri.tryParse(route.baseUrl);
  if (uri == null || uri.host.isEmpty) return null;
  return uri.origin;
}

class AgentCallApi {
  AgentCallApi({
    required this.origin,
    required this.communityId,
    required this.nsec,
    http.Client? httpClient,
  }) : _client = httpClient ?? http.Client();

  final String origin;
  final String communityId;
  final String nsec;
  final http.Client _client;

  void close() => _client.close();

  Future<Object?> _send(String method, String path, [Object? body]) async {
    final url = '$origin$agentCallMount/$path';
    final bytes = body == null ? const <int>[] : utf8.encode(jsonEncode(body));
    final request = http.Request(method, Uri.parse(url))
      ..followRedirects = false
      ..headers['Accept'] = 'application/json'
      ..headers['X-Buzz-Community'] = communityId
      ..headers['Authorization'] = buildNip98AuthHeader(
        method: method,
        url: url,
        bodyBytes: bytes,
        nsec: nsec,
      );
    if (body != null) {
      request.headers['Content-Type'] = 'application/json';
      request.bodyBytes = bytes;
    }
    http.Response response;
    try {
      final streamed = await _client.send(request).timeout(_requestTimeout);
      response = await http.Response.fromStream(
        streamed,
      ).timeout(_requestTimeout);
    } on TimeoutException {
      throw const AgentCallApiException(null, 'voice_route_timeout');
    } on http.ClientException {
      throw const AgentCallApiException(null, 'network');
    }
    Object? decoded;
    if (response.bodyBytes.isNotEmpty) {
      try {
        decoded = jsonDecode(utf8.decode(response.bodyBytes));
      } on FormatException {
        decoded = null;
      }
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      final code = decoded is Map && decoded['error'] is String
          ? decoded['error'] as String
          : null;
      throw AgentCallApiException(response.statusCode, code);
    }
    return decoded;
  }

  String _call(String callId) => 'calls/${Uri.encodeComponent(callId)}';

  Future<AgentCallStart> start({
    required String agentPubkey,
    required String channelId,
    required String sdpOffer,
    required String clientTapAt,
    required String systemCallUI,
  }) async {
    final body = await _send('POST', 'calls', {
      'agentPubkey': agentPubkey,
      'channelId': channelId,
      'sdpOffer': sdpOffer,
      'clientTapAt': clientTapAt,
      'clientDiagnostics': {'systemCallUI': systemCallUI},
    });
    if (body is! Map ||
        body['callId'] is! String ||
        body['sdpAnswer'] is! String) {
      throw const AgentCallApiException(null, 'response_invalid');
    }
    final until = body['executeUntil'];
    return AgentCallStart(
      callId: body['callId'] as String,
      sdpAnswer: body['sdpAnswer'] as String,
      executeUntil: until is String ? DateTime.tryParse(until) : null,
    );
  }

  Future<void> end(String callId, String reason) async {
    await _send('POST', '${_call(callId)}/end', {'reason': reason});
  }

  Future<AgentCallStopOutcome> stopWork(String callId) async {
    try {
      await _send('POST', '${_call(callId)}/stop', {
        'idempotencyKey': newAgentCallIdempotencyKey(),
      });
      return AgentCallStopOutcome.stopped;
    } on AgentCallApiException catch (error) {
      if (error.code == 'voice_nothing_to_stop') {
        return AgentCallStopOutcome.nothingToStop;
      }
      rethrow;
    }
  }

  /// Feed v2 long-poll: the whole snapshot, or null when unchanged after
  /// waiting (the second value is then the unchanged `rev`).
  Future<(AgentCallFeed?, String?)> feed(
    String callId, {
    String? rev,
    int waitSeconds = 20,
  }) async {
    final query = <String, String>{
      'rev': ?rev,
      'wait': '${waitSeconds.clamp(0, 20)}',
    };
    final body = await _send(
      'GET',
      '${_call(callId)}/feed?${Uri(queryParameters: query).query}',
    );
    if (body is! Map<String, Object?>) {
      throw const AgentCallApiException(null, 'response_invalid');
    }
    if (body['unchanged'] == true) {
      return (null, body['rev'] is String ? body['rev'] as String : rev);
    }
    final feed = AgentCallFeed.tryParse(body);
    if (feed == null) {
      throw const AgentCallApiException(null, 'response_invalid');
    }
    return (feed, feed.rev);
  }

  Future<void> answerQuestion({
    required String callId,
    required String humanAskId,
    required String? questionId,
    required int optionIndex,
  }) async {
    await _send(
      'POST',
      '${_call(callId)}/human-asks/${Uri.encodeComponent(humanAskId)}/answer',
      {
        'questionId': ?questionId,
        'optionIndex': optionIndex,
        'idempotencyKey': newAgentCallIdempotencyKey(),
      },
    );
  }

  Future<void> cancelAsk(String callId, String askKey) async {
    await _send('POST', '${_call(callId)}/asks/cancel', {
      'askKey': askKey,
      'idempotencyKey': newAgentCallIdempotencyKey(),
    });
  }

  Future<void> archiveAsk(String callId, String askKey) async {
    await _send('POST', '${_call(callId)}/asks/state', {
      'askKey': askKey,
      'action': 'archive',
      'idempotencyKey': newAgentCallIdempotencyKey(),
    });
  }
}

/// A plain sentence for a failed request (codes only, never content).
String describeAgentCallError(Object error) {
  final code = error is AgentCallApiException ? error.code : null;
  final status = error is AgentCallApiException ? error.status : null;
  switch (code) {
    case 'voice_call_in_progress':
      return "You're already on a call. Hang up there first.";
    case 'voice_buzz_dm_required':
      return 'Calls work only in your private DM with this agent.';
    case 'voice_buzz_dm_unverified':
      return "Couldn't confirm this DM with the relay. Try again.";
    case 'caller_not_allowed':
      return "Your account isn't linked for calls with this agent.";
    case 'agent_not_found':
      return "This agent can't take calls.";
    case 'voice_disabled':
      return 'Calls are turned off for this agent.';
    case 'voice_conversation_unavailable':
      return "This agent can't open a conversation with you yet.";
    case 'rate_limited':
    case 'voice_daily_limit':
      return "You've reached the call limit for now. Try again later.";
    case 'voice_route_timeout':
    case 'network':
      return "Couldn't reach the call service. Check your connection.";
    case 'nip98_expired':
      return "The call request expired. Check your phone's clock.";
  }
  if (status == 401) return "Couldn't sign the call request. Try again.";
  return 'Calls are unavailable right now. Try again.';
}
