import 'package:flutter/foundation.dart';

/// A hosted-agent failure: the contract's bounded `error` code plus what the
/// API chose to tell the owner.
@immutable
class HostedAgentException implements Exception {
  const HostedAgentException(
    this.code, {
    this.status,
    this.serverMessage,
    this.remediationUrl,
    this.supportId,
    this.remoteAbsent = false,
  });

  /// Bounded machine code (`[A-Za-z0-9_-]{1,160}`).
  final String code;

  /// HTTP status, when the API answered.
  final int? status;

  /// The API's plain-language message, when it sent one.
  final String? serverMessage;

  /// An `https` page where the owner can fix the cause (for example, connect a
  /// subscription).
  final String? remediationUrl;

  /// The API's correlation id, shown as a support id.
  final String? supportId;

  /// The API asserted, after verifying the owner, that no remote agent exists
  /// for this agent key (`agent_state: "absent"`). Only that exact statement
  /// counts; every other failure leaves remote state unknown.
  final bool remoteAbsent;

  /// Plain-language text for the owner. Attach and service-setup codes use
  /// this app's own words, since they name a choice the owner made here.
  String get message =>
      _ownedHostedAgentCopy(code) ??
      serverMessage ??
      describeHostedAgentError(code);

  @override
  String toString() => 'HostedAgentException($code, $status)';
}

const _hostedCodePrefix = 'buzz_hosted_';

/// Text for codes this app words itself, or `null`. Codes may carry the
/// API's `buzz_hosted_` prefix.
String? _ownedHostedAgentCopy(String code) {
  final bare = code.startsWith(_hostedCodePrefix)
      ? code.substring(_hostedCodePrefix.length)
      : code;
  if (bare.startsWith('provisioning_keys_')) {
    return "The hosted agent service can't set up agents right now. Try again later.";
  }
  return switch (bare) {
    'kiingo_agent_id_invalid' =>
      "That existing agent can't be used. Pick it again or create a new one.",
    'already_has_buzz_identity' =>
      'That agent is already on Buzz. Pick another one, or create a new agent.',
    'not_agent_owner' =>
      'You can only bring an agent you own. Pick one of yours, or create a new agent.',
    'agent_spec_required' =>
      "That agent isn't set up to run yet. Finish setting it up, then try again.",
    'scope_unconfigured' =>
      "Hosted agents aren't set up for this community yet.",
    _ => null,
  };
}

/// Plain-language text for client-side and transport error codes.
String describeHostedAgentError(String code) =>
    _ownedHostedAgentCopy(code) ?? _describeHostedAgentCode(code);

String _describeHostedAgentCode(String code) => switch (code) {
  'hosted_agents_unavailable' =>
    "Hosted agents aren't available in this build or community.",
  'hosted_agents_unreachable' || 'hosted_agents_timeout' =>
    "Couldn't reach the hosted agent service. Check your connection and try again.",
  'signing_unavailable' =>
    "This device can't sign for your identity. Pair it again and retry.",
  'capability_public_key_not_trusted' ||
  'capability_signature_invalid' ||
  'capability_payload_hash_mismatch' ||
  'capability_signature_missing' ||
  'capability_api_base_mismatch' =>
    "The hosted agent service sent options this app can't verify. Update Buzz and try again.",
  'capability_window_invalid' =>
    "The hosted agent options have expired or your phone's clock is off. Check the date and time, then retry.",
  'provider_config_harness_unavailable' => 'Choose an available harness.',
  'provider_config_model_unavailable' ||
  'provider_config_reasoning_unavailable' ||
  'provider_config_service_tier_unavailable' =>
    'That model choice is no longer available. Pick another one.',
  'agent_system_prompt_too_large' =>
    'The instructions are too long. Shorten them and try again.',
  'agent_name_invalid' => 'Give the agent a name.',
  'response_invalid' ||
  'delete_response_not_terminal' ||
  'preflight_response_invalid' =>
    'The hosted agent service sent an answer this app does not understand.',
  'rate_limited' => 'Too many requests. Wait a moment and try again.',
  'cleanup_pending' =>
    'An earlier create still needs cleaning up. Try the cleanup again before creating another agent.',
  _ =>
    'The hosted agent service could not complete this request. Retry safely.',
};

final _boundedCode = RegExp(r'^[A-Za-z0-9_-]{1,160}$');

/// Map an API error body to an exception the same way the desktop's bundled
/// provider does: only a bounded code, a bounded message, an `https`
/// remediation link and a bounded support id survive.
HostedAgentException hostedAgentFailure(
  Object? body, {
  required int status,
  required String fallbackCode,
  bool readAgentState = false,
}) {
  final map = body is Map ? body : const {};
  final rawCode = map['error'];
  final code = rawCode is String && _boundedCode.hasMatch(rawCode)
      ? rawCode
      : (status == 429 ? 'rate_limited' : fallbackCode);
  final rawMessage = map['message'];
  final message =
      rawMessage is String &&
          rawMessage.trim().isNotEmpty &&
          rawMessage.length <= 1000
      ? rawMessage.trim()
      : null;
  final rawUrl = map['remediation_url'];
  final remediation =
      rawUrl is String && rawUrl.length <= 2048 && isSafeHttpsUrl(rawUrl)
      ? rawUrl
      : null;
  final rawSupport = map['correlation_id'];
  final support = rawSupport is String && _boundedCode.hasMatch(rawSupport)
      ? rawSupport
      : null;
  return HostedAgentException(
    code,
    status: status,
    serverMessage: message,
    remediationUrl: remediation,
    supportId: support,
    remoteAbsent: readAgentState && map['agent_state'] == 'absent',
  );
}

/// An `https` URL with a host and no user info.
bool isSafeHttpsUrl(String value) {
  final uri = Uri.tryParse(value.trim());
  return uri != null &&
      uri.scheme == 'https' &&
      uri.host.isNotEmpty &&
      uri.userInfo.isEmpty;
}
