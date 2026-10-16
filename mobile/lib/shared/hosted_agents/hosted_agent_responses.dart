import 'package:flutter/foundation.dart';

import 'hosted_agent_errors.dart';

/// Owner readiness for one configuration.
@immutable
class HostedPreflight {
  const HostedPreflight({
    required this.ready,
    this.message,
    this.notice,
    this.actionLabel,
    this.actionUrl,
  });

  final bool ready;

  /// Why the owner is not ready, at most 300 characters.
  final String? message;

  /// One plain line shown under the fields, at most 300 characters.
  final String? notice;

  /// Button text for [actionUrl], at most 40 characters.
  final String? actionLabel;

  /// An `https` page that fixes the cause.
  final String? actionUrl;
}

String? _boundedText(Object? value, int max) {
  if (value is! String) return null;
  final text = value.trim();
  if (text.isEmpty ||
      text.runes.length > max ||
      text.runes.any((rune) => rune < 0x20 || (rune >= 0x7f && rune < 0xa0))) {
    return null;
  }
  return text;
}

/// Map the API's preflight answer to exactly the fields the desktop accepts:
/// bounded single-line text and an `https` action link, so the API cannot put
/// arbitrary content or links in the create form.
HostedPreflight parseHostedPreflight(Object? body, String requestId) {
  if (body is! Map ||
      body['contract_version'] != 1 ||
      body['correlation_id'] != requestId ||
      body['ready'] is! bool) {
    throw const HostedAgentException('preflight_response_invalid');
  }
  final rawUrl = body['action_url'];
  final url =
      rawUrl is String && rawUrl.trim().length <= 2048 && isSafeHttpsUrl(rawUrl)
      ? rawUrl.trim()
      : null;
  return HostedPreflight(
    ready: body['ready'] as bool,
    message: _boundedText(body['message'], 300),
    notice: _boundedText(body['notice'], 300),
    actionLabel: url == null ? null : _boundedText(body['action_label'], 40),
    actionUrl: url,
  );
}

/// The API's view of one hosted agent after a create.
@immutable
class HostedAgentState {
  const HostedAgentState({
    required this.providerAgentId,
    this.desiredState,
    this.observedState,
  });

  /// Stable id used for confirmed delete.
  final String providerAgentId;
  final String? desiredState;
  final String? observedState;
}

final _stateWord = RegExp(r'^[a-z_]{1,40}$');

String? _stateValue(Object? value) =>
    value is String && _stateWord.hasMatch(value) ? value : null;

/// Parse a successful provision response; it must carry the agent id.
HostedAgentState parseHostedAgentState(Object? body) {
  if (body is! Map) throw const HostedAgentException('response_invalid');
  final id = body['provider_agent_id'];
  if (id is! String || id.trim().isEmpty || id.length > 256) {
    throw const HostedAgentException('response_invalid');
  }
  return HostedAgentState(
    providerAgentId: id,
    desiredState: _stateValue(body['desired_state']),
    observedState: _stateValue(body['observed_state']),
  );
}

/// A confirmed delete must report exactly this terminal state for exactly
/// this agent and request; anything else is not confirmation.
void validateConfirmedDelete(
  Object? body, {
  required String requestId,
  required String providerAgentId,
}) {
  const expected = {
    'contract_version',
    'provider_agent_id',
    'observed_state',
    'identity_destroyed',
    'correlation_id',
  };
  if (body is! Map ||
      body.length != expected.length ||
      !body.keys.every(expected.contains) ||
      body['contract_version'] != 1 ||
      body['provider_agent_id'] != providerAgentId ||
      body['observed_state'] != 'deleted' ||
      body['identity_destroyed'] != true ||
      body['correlation_id'] != requestId) {
    throw const HostedAgentException('delete_response_not_terminal');
  }
}
