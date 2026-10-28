import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:uuid/uuid.dart';

import '../../shared/guest_access/guest_access_client.dart';
import '../../shared/relay/relay.dart';
import 'agent_call_feed.dart';
import 'voice_provider.dart';

/// The agent host's call routes for this app (`<origin>/api/buzz-voice/ios`),
/// every request NIP-98 signed by the signed-in user (exact URL with query,
/// method, and the SHA-256 of the exact body bytes) with `X-Buzz-Community`.
/// The host starts a call only from the caller's private 1:1 DM with the
/// agent and serves each call to its caller only.
const agentCallMount = '/api/buzz-voice/ios';

/// The feed long-poll waits up to 20 s on the host.
const _requestTimeout = Duration(seconds: 35);

class AgentCallApiException implements Exception {
  const AgentCallApiException(this.status, this.code, [this.reason]);

  final int? status;
  final String? code;

  /// `details.reason` of `voice_provider_unavailable` (a code, never content).
  final String? reason;

  @override
  String toString() => 'AgentCallApiException($status, $code)';
}

class AgentCallStart {
  const AgentCallStart({
    required this.callId,
    required this.sdpAnswer,
    required this.executeUntil,
    this.provider,
  });

  final String callId;
  final String sdpAnswer;
  final DateTime? executeUntil;

  /// Null from a host older than the provider choice.
  final VoiceStartProvider? provider;
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
    int status;
    Uint8List responseBytes;
    try {
      final streamed = await _client.send(request).timeout(_requestTimeout);
      status = streamed.statusCode;
      responseBytes = await _readCapped(streamed).timeout(_requestTimeout);
    } on TimeoutException {
      throw const AgentCallApiException(null, 'voice_route_timeout');
    } on http.ClientException {
      throw const AgentCallApiException(null, 'network');
    }
    Object? decoded;
    if (responseBytes.isNotEmpty) {
      try {
        decoded = jsonDecode(utf8.decode(responseBytes));
      } on FormatException {
        decoded = null;
      }
    }
    if (status < 200 || status >= 300) {
      final code = decoded is Map && decoded['error'] is String
          ? decoded['error'] as String
          : null;
      final details = decoded is Map ? decoded['details'] : null;
      final reason = details is Map && details['reason'] is String
          ? details['reason'] as String
          : null;
      throw AgentCallApiException(status, code, reason);
    }
    return decoded;
  }

  /// The answer's bytes, at most [guestAccessMaxResponseBytes]: a larger
  /// declared length is refused before reading, and reading stops past it.
  static Future<Uint8List> _readCapped(http.StreamedResponse response) async {
    final status = response.statusCode;
    final declared = response.contentLength;
    if (declared != null && declared > guestAccessMaxResponseBytes) {
      throw AgentCallApiException(status, 'response_too_large');
    }
    final bytes = BytesBuilder(copy: false);
    await for (final chunk in response.stream) {
      if (bytes.length + chunk.length > guestAccessMaxResponseBytes) {
        throw AgentCallApiException(status, 'response_too_large');
      }
      bytes.add(chunk);
    }
    return bytes.takeBytes();
  }

  String _call(String callId) => 'calls/${Uri.encodeComponent(callId)}';

  Future<AgentCallStart> start({
    required String agentPubkey,
    required String channelId,
    required String sdpOffer,
    required String clientTapAt,
    required String systemCallUI,
    VoiceProviderId? provider,
  }) async {
    final body = await _send('POST', 'calls', {
      'agentPubkey': agentPubkey,
      'channelId': channelId,
      'sdpOffer': sdpOffer,
      'clientTapAt': clientTapAt,
      'clientDiagnostics': {'systemCallUI': systemCallUI},
      // Only a chooser pick: a plain tap lets the host resolve the voice
      // (the caller's override for this agent, then their default).
      'provider': ?provider?.wire,
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
      provider: VoiceStartProvider.tryParse(body['provider']),
    );
  }

  /// The caller's voice settings for this agent (§9.1), by its key. Null
  /// from a host without the settings read (then there's no chooser).
  Future<VoiceSettings?> voiceSettings(String agentPubkey) async {
    try {
      return VoiceSettings.tryParse(
        await _send(
          'GET',
          'settings?agentPubkey=${Uri.encodeQueryComponent(agentPubkey)}',
        ),
      );
    } on AgentCallApiException catch (error) {
      if (error.status == 404 && error.code == null) return null;
      rethrow;
    }
  }

  /// "Make … my default" (`null` clears it).
  Future<VoiceSettings?> setVoiceDefault(
    VoiceProviderId? provider,
    int expectedRevision,
  ) async => VoiceSettings.tryParse(
    await _send('PUT', 'settings', {
      'defaultProvider': provider?.wire,
      'expectedRevision': expectedRevision,
    }),
  );

  /// "Always use … for this agent" (`null` clears it), by the agent's id.
  Future<VoiceSettings?> setVoiceOverride(
    String agentId,
    VoiceProviderId? provider,
    int expectedRevision,
  ) async => VoiceSettings.tryParse(
    await _send('PUT', 'settings/agents/${Uri.encodeComponent(agentId)}', {
      'provider': provider?.wire,
      'expectedRevision': expectedRevision,
    }),
  );

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
    case 'voice_provider_unavailable':
    case 'voice_provider_unsupported':
      return voiceProviderUnavailableSentence(
        error is AgentCallApiException ? error.reason : null,
        'Gemini',
      );
    case 'voice_transport_unsupported':
      return voiceProviderUnavailableSentence('client_transport', 'Gemini');
    case 'voice_stream_origin_unconfigured':
      return voiceProviderUnavailableSentence('provider_error', 'Gemini');
  }
  if (status == 401) return "Couldn't sign the call request. Try again.";
  return 'Calls are unavailable right now. Try again.';
}

/// Codes that mean the chosen voice can't take this call (the screen then
/// offers the same call with GPT-Live).
bool isVoiceProviderUnavailable(Object error) {
  final code = error is AgentCallApiException ? error.code : null;
  return code == 'voice_provider_unavailable' ||
      code == 'voice_transport_unsupported' ||
      code == 'voice_provider_unsupported' ||
      code == 'voice_stream_origin_unconfigured';
}

/// One sentence for a failed settings write.
String describeVoiceSettingsError(Object error) {
  final code = error is AgentCallApiException ? error.code : null;
  return switch (code) {
    'voice_settings_conflict' =>
      'Your voice choice changed on another device. Showing the latest.',
    'voice_provider_unsupported' => "That voice isn't one Kiingo offers.",
    'agent_not_found' => "This isn't an agent you can call.",
    _ => "Couldn't save your voice choice. Try again.",
  };
}
