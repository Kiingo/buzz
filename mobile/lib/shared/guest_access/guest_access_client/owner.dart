part of '../guest_access_client.dart';

String _query(Map<String, Object?> params) {
  final entries = {
    for (final entry in params.entries)
      if (entry.value != null && '${entry.value}'.isNotEmpty)
        entry.key: '${entry.value}',
  };
  return entries.isEmpty ? '' : '?${Uri(queryParameters: entries).query}';
}

String _id(String value) => Uri.encodeComponent(value);

/// The owner management routes desktop's Access dialog uses (contracts
/// §5-§9, §12.1): agents and their hosted-answer switch, grants, blocks, the
/// access log, the daily digest, shareables, learned-grant suggestions and
/// the org-admin safety overview. Request and response shapes are the
/// route's; nothing here adds or changes an endpoint.
extension GuestAccessOwnerApi on GuestAccessClient {
  /// The owner's agents registered with the guest route.
  Future<List<GuestOwnerAgent>> ownerAgents() async =>
      parseOwnerAgents(await _request('GET', '/owner/agents'));

  /// Turn hosted answers for other people on or off for one agent.
  Future<void> setAgentEnabled(String guestEndpointId, bool enabled) async {
    await _request(
      'PATCH',
      '/owner/agents/${_id(guestEndpointId)}',
      body: {'enabled': enabled},
    );
  }

  /// Grants across all agents (the route omits revoked grants).
  Future<List<GuestGrant>> grants({String? guestEndpointId}) async =>
      parseGrantList(
        await _request(
          'GET',
          '/owner/grants${_query({'agent': guestEndpointId})}',
        ),
      );

  /// Revoke one grant. It stops applying within 10 minutes.
  Future<void> revokeGrant(String grantId) async {
    await _request('DELETE', '/owner/grants/${_id(grantId)}');
  }

  /// People blocked from all agents or one agent.
  Future<List<GuestBlock>> blocks() async =>
      parseBlockList(await _request('GET', '/owner/blocks'));

  /// Block a person; `guestEndpointId` `null` blocks them from every agent.
  Future<void> block({
    required String pubkey,
    String? guestEndpointId,
    String? reason,
  }) async {
    await _request(
      'POST',
      '/owner/blocks',
      body: {
        'guest_endpoint_id': guestEndpointId,
        'pubkey': pubkey.toLowerCase(),
        if (reason != null && reason.isNotEmpty) 'reason': reason,
      },
    );
  }

  /// Lift one block.
  Future<void> unblock(String blockId) async {
    await _request('DELETE', '/owner/blocks/${_id(blockId)}');
  }

  /// One page of recent guest requests, newest first. `cursor` is the
  /// previous page's `nextCursor`.
  Future<GuestAccessLogPage> accessLog({
    String? guestEndpointId,
    String? cursor,
    int limit = 50,
  }) async => parseAccessLog(
    await _request(
      'GET',
      '/owner/access-log${_query({'agent': guestEndpointId, 'cursor': cursor, 'limit': limit})}',
    ),
  );

  /// The digest for one UTC day (YYYY-MM-DD). Read-only.
  Future<GuestDigest> digest(String date) async => parseDigest(
    await _request('GET', '/owner/digest${_query({'date': date})}'),
  );

  /// Items marked "shared via my agent".
  Future<List<GuestShareable>> shareables() async =>
      parseShareableList(await _request('GET', '/owner/shareables'));

  /// Share a status or a note through the owner's agents.
  Future<void> addShareable({
    required String resourceKind,
    required String content,
    String? guestEndpointId,
    int? expiresInDays,
  }) async {
    await _request(
      'POST',
      '/owner/shareables',
      body: {
        'resource_kind': resourceKind,
        'content': content,
        'guest_endpoint_id': ?guestEndpointId,
        'expires_in_days': ?expiresInDays,
      },
    );
  }

  /// Stop sharing one item.
  Future<void> removeShareable(String shareableId) async {
    await _request('DELETE', '/owner/shareables/${_id(shareableId)}');
  }

  /// Open learned-grant suggestions.
  Future<List<GuestSuggestion>> suggestions() async =>
      parseSuggestionList(await _request('GET', '/owner/suggestions'));

  /// Accept (creates a grant) or dismiss a suggestion.
  Future<void> decideSuggestion(
    String suggestionId, {
    required bool accept,
  }) async {
    await _request(
      'POST',
      '/owner/suggestions/${_id(suggestionId)}/${accept ? 'accept' : 'dismiss'}',
      body: const {},
    );
  }

  /// Org-admin guest safety; throws `admin_required` for everyone else.
  Future<GuestAdminOverview> adminOverview() async =>
      parseAdminOverview(await _request('GET', '/admin/alerts'));

  /// Mark one org-admin alert reviewed.
  Future<void> acknowledgeAdminAlert(String alertId) async {
    await _request('POST', '/admin/alerts/${_id(alertId)}/ack', body: const {});
  }

  /// Restore a suspended requester's guest access org-wide.
  Future<void> restoreRequester(String pubkey) async {
    await _request(
      'POST',
      '/admin/requesters/${_id(pubkey.toLowerCase())}/review',
      body: const {},
    );
  }
}

/// Whether a route error means "you are not an org admin".
bool isAdminRequired(Object? error) =>
    error is GuestAccessException &&
    (error.code == 'admin_required' || error.status == 403);
