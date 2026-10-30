/// Typed views of the hosted guest-access route's owner management records:
/// the owner's agents, grants, blocks, access log, digest, shareables,
/// learned-grant suggestions and the org-admin safety overview.
///
/// This mirrors the desktop readers (desktop/src/features/guest-access
/// `lib/wire.ts`). The route speaks snake_case and may add fields at any
/// time, so every reader here tolerates missing or unknown fields and never
/// throws on a malformed record.
library;

import 'guest_approval.dart';

/// One of the owner's agents registered with the guest route.
class GuestOwnerAgent {
  const GuestOwnerAgent({
    required this.guestEndpointId,
    required this.pubkey,
    this.displayName,
    this.enabled = true,
    this.respondTo,
    this.lastSeenAt,
  });

  final String guestEndpointId;

  /// Lowercase hex.
  final String pubkey;
  final String? displayName;

  /// Whether other people are answered through the hosted route.
  final bool enabled;

  /// `owner-only`, `anyone`, `allowlist` or `nobody`, as the agent last
  /// reported it.
  final String? respondTo;
  final String? lastSeenAt;
}

class GuestGrantee {
  const GuestGrantee({this.userId, this.pubkey, this.displayName, this.kind});

  final String? userId;
  final String? pubkey;
  final String? displayName;
  final String? kind;
}

class GuestGrant {
  const GuestGrant({
    required this.grantId,
    this.guestEndpointId,
    this.grantee = const GuestGrantee(),
    this.scope = GrantScope.once,
    this.threadRootEventId,
    this.questionKind,
    this.dataSources = const [],
    this.expiresAt,
    this.revokedAt,
    this.useCount = 0,
    this.lastUsedAt,
    this.createdAt,
  });

  final String grantId;
  final String? guestEndpointId;
  final GuestGrantee grantee;
  final GrantScope scope;
  final String? threadRootEventId;
  final String? questionKind;
  final List<String> dataSources;
  final String? expiresAt;
  final String? revokedAt;
  final int useCount;
  final String? lastUsedAt;
  final String? createdAt;
}

class GuestBlock {
  const GuestBlock({
    required this.blockId,
    required this.pubkey,
    this.guestEndpointId,
    this.displayName,
    this.reason,
    this.createdAt,
  });

  final String blockId;

  /// `null` blocks the person from all of the owner's agents.
  final String? guestEndpointId;
  final String pubkey;
  final String? displayName;
  final String? reason;
  final String? createdAt;
}

class GuestAccessLogEntry {
  const GuestAccessLogEntry({
    required this.entryId,
    required this.requester,
    this.at,
    this.guestTurnId,
    this.guestEndpointId,
    this.tier,
    this.outcome = 'unknown',
    this.dataSources = const [],
    this.classifier = const GuestClassifier(),
    this.approvalId,
    this.questionText,
  });

  final String entryId;
  final String? at;
  final String? guestTurnId;
  final String? guestEndpointId;
  final GuestRequester requester;
  final int? tier;
  final String outcome;
  final List<String> dataSources;
  final GuestClassifier classifier;
  final String? approvalId;

  /// Kept only for blocked or high-risk requests, for 30 days.
  final String? questionText;
}

class GuestAccessLogPage {
  const GuestAccessLogPage({this.items = const [], this.nextCursor});

  final List<GuestAccessLogEntry> items;
  final String? nextCursor;
}

class GuestShareable {
  const GuestShareable({
    required this.shareableId,
    this.guestEndpointId,
    this.resourceKind = 'note',
    this.resourceId,
    this.content,
    this.audienceKind,
    this.expiresAt,
    this.createdAt,
  });

  final String shareableId;
  final String? guestEndpointId;

  /// `status`, `note` or `knowledge_item`.
  final String resourceKind;
  final String? resourceId;
  final String? content;
  final String? audienceKind;
  final String? expiresAt;
  final String? createdAt;
}

class GuestSuggestion {
  const GuestSuggestion({
    required this.suggestionId,
    this.guestEndpointId,
    this.granteeDisplayName,
    this.questionKind,
    this.dataSources = const [],
    this.approvalsCount = 0,
    this.proposedScope = GrantScope.once,
    this.agentProposed = false,
    this.days,
    this.proposedVia,
    this.proposedByAgentName,
  });

  final String suggestionId;
  final String? guestEndpointId;
  final String? granteeDisplayName;
  final String? questionKind;
  final List<String> dataSources;
  final int approvalsCount;
  final GrantScope proposedScope;

  /// An agent or your MCP client asked for this grant (Kiingo 79 ruling 5);
  /// otherwise it is learned from what you keep approving.
  final bool agentProposed;

  /// Days for a `person_days` proposal.
  final int? days;

  /// `agent_run` or `mcp_client` (proposals only).
  final String? proposedVia;

  /// The proposing agent's name (proposals only).
  final String? proposedByAgentName;
}

class GuestDigestRequester {
  const GuestDigestRequester({
    required this.pubkey,
    this.displayName,
    this.count = 0,
  });

  final String pubkey;
  final String? displayName;
  final int count;
}

/// One UTC day of guest activity across all of the owner's agents. The route
/// builds it on request; there are no digest settings to change.
class GuestDigest {
  const GuestDigest({
    this.date = '',
    this.total = 0,
    this.byOutcome = const {},
    this.byRequester = const [],
    this.flaggedRequests = 0,
    this.pendingApprovals = 0,
    this.openSuggestions = 0,
  });

  final String date;
  final int total;
  final Map<String, int> byOutcome;
  final List<GuestDigestRequester> byRequester;
  final int flaggedRequests;
  final int pendingApprovals;
  final int openSuggestions;

  bool get isQuiet => total == 0 && pendingApprovals == 0;
}

/// An open org-admin guest safety alert (`GET /admin/alerts`).
class GuestAdminAlert {
  const GuestAdminAlert({
    required this.alertId,
    required this.kind,
    this.severity = 'info',
    this.pattern,
    this.requesterPubkey,
    this.count,
    this.createdAt,
  });

  final String alertId;

  /// `requester_suspended` or `org_pattern`.
  final String kind;

  /// `high` or `info`.
  final String severity;

  /// `flagged_across_owners` or `approval_requests_across_agents`.
  final String? pattern;
  final String? requesterPubkey;

  /// Distinct owners (or agents) involved, or high flags in 24 h.
  final int? count;
  final String? createdAt;
}

/// A requester whose guest access is suspended org-wide pending review.
class GuestSuspendedRequester {
  const GuestSuspendedRequester({
    required this.pubkey,
    this.userId,
    this.suspendedAt,
    this.reason,
  });

  final String pubkey;
  final String? userId;
  final String? suspendedAt;
  final String? reason;
}

class GuestAdminOverview {
  const GuestAdminOverview({this.alerts = const [], this.suspended = const []});

  final List<GuestAdminAlert> alerts;
  final List<GuestSuspendedRequester> suspended;

  bool get isEmpty => alerts.isEmpty && suspended.isEmpty;
}

// ── Readers ────────────────────────────────────────────────────────────────

Map<String, Object?> _obj(Object? value) =>
    value is Map ? value.cast<String, Object?>() : const {};

String? _str(Object? value) =>
    value is String && value.isNotEmpty ? value : null;

int? _int(Object? value) =>
    value is num && value.isFinite ? value.toInt() : null;

List<String> _strings(Object? value) => value is List
    ? [
        for (final entry in value)
          if (entry is String) entry,
      ]
    : const [];

/// A bare list, or the `items` list of `{items: [...]}`.
List<Object?> _items(Object? value) {
  if (value is List) return value;
  final items = _obj(value)['items'];
  return items is List ? items : const [];
}

GrantScope _scope(Object? value) =>
    grantScopeFromWire(value) ?? GrantScope.once;

GuestClassifier _classifier(Object? value) {
  final raw = _obj(value);
  final scores = <String, double>{};
  for (final entry in _obj(raw['top_scores'] ?? raw['scores']).entries) {
    final score = entry.value;
    if (score is num && score.isFinite) scores[entry.key] = score.toDouble();
  }
  return GuestClassifier(
    route: _str(raw['route']),
    severity: _str(raw['severity']),
    categories: _strings(raw['categories']),
    topScores: scores,
  );
}

List<GuestOwnerAgent> parseOwnerAgents(Object? value) {
  final agents = _obj(value)['agents'];
  return [
    for (final entry in agents is List ? agents : _items(value))
      ?_parseOwnerAgent(entry),
  ];
}

GuestOwnerAgent? _parseOwnerAgent(Object? value) {
  final raw = _obj(value);
  final id = _str(raw['guest_endpoint_id']);
  final pubkey = _str(raw['pubkey']);
  if (id == null || pubkey == null) return null;
  return GuestOwnerAgent(
    guestEndpointId: id,
    pubkey: pubkey.toLowerCase(),
    displayName: _str(raw['display_name']),
    enabled: raw['enabled'] != false,
    respondTo: _str(raw['respond_to']),
    lastSeenAt: _str(raw['last_seen_at']),
  );
}

GuestGrant? parseGrant(Object? value) {
  final raw = _obj(value);
  final grantId = _str(raw['grant_id']);
  if (grantId == null) return null;
  final grantee = _obj(raw['grantee']);
  return GuestGrant(
    grantId: grantId,
    guestEndpointId: _str(raw['guest_endpoint_id']),
    grantee: GuestGrantee(
      userId: _str(grantee['user_id']),
      pubkey: _str(grantee['pubkey']),
      displayName: _str(grantee['display_name']),
      kind: _str(grantee['kind']),
    ),
    scope: _scope(raw['scope']),
    threadRootEventId: _str(raw['thread_root_event_id']),
    questionKind: _str(raw['question_kind']),
    dataSources: _strings(raw['data_sources']),
    expiresAt: _str(raw['expires_at']),
    revokedAt: _str(raw['revoked_at']),
    useCount: _int(raw['use_count']) ?? 0,
    lastUsedAt: _str(raw['last_used_at']),
    createdAt: _str(raw['created_at']),
  );
}

List<GuestGrant> parseGrantList(Object? value) => [
  for (final entry in _items(value)) ?parseGrant(entry),
];

List<GuestBlock> parseBlockList(Object? value) => [
  for (final entry in _items(value))
    if (_obj(entry) case final raw
        when _str(raw['block_id']) != null && _str(raw['pubkey']) != null)
      GuestBlock(
        blockId: _str(raw['block_id'])!,
        guestEndpointId: _str(raw['guest_endpoint_id']),
        pubkey: _str(raw['pubkey'])!.toLowerCase(),
        displayName: _str(raw['display_name']),
        reason: _str(raw['reason']),
        createdAt: _str(raw['created_at']),
      ),
];

GuestAccessLogPage parseAccessLog(Object? value) => GuestAccessLogPage(
  items: [
    for (final entry in _items(value))
      if (_obj(entry) case final row when _str(row['entry_id']) != null)
        GuestAccessLogEntry(
          entryId: _str(row['entry_id'])!,
          at: _str(row['at']),
          guestTurnId: _str(row['guest_turn_id']),
          guestEndpointId: _str(row['guest_endpoint_id']),
          requester: parseRequester(row['requester']),
          tier: _int(row['tier']),
          outcome: _str(row['outcome']) ?? 'unknown',
          dataSources: _strings(row['data_sources']),
          classifier: _classifier(row['classifier']),
          approvalId: _str(row['approval_id']),
          questionText: _str(row['question_text']),
        ),
  ],
  nextCursor: _str(_obj(value)['next_cursor']),
);

List<GuestShareable> parseShareableList(Object? value) => [
  for (final entry in _items(value))
    if (_obj(entry) case final raw when _str(raw['shareable_id']) != null)
      GuestShareable(
        shareableId: _str(raw['shareable_id'])!,
        guestEndpointId: _str(raw['guest_endpoint_id']),
        resourceKind: _str(raw['resource_kind']) ?? 'note',
        resourceId: _str(raw['resource_id']),
        content: _str(raw['content']),
        audienceKind: _str(raw['audience_kind']),
        expiresAt: _str(raw['expires_at']),
        createdAt: _str(raw['created_at']),
      ),
];

List<GuestSuggestion> parseSuggestionList(Object? value) => [
  for (final entry in _items(value))
    if (_obj(entry) case final raw when _str(raw['suggestion_id']) != null)
      GuestSuggestion(
        suggestionId: _str(raw['suggestion_id'])!,
        guestEndpointId: _str(raw['guest_endpoint_id']),
        granteeDisplayName: _str(_obj(raw['grantee'])['display_name']),
        questionKind: _str(raw['question_kind']),
        dataSources: _strings(raw['data_sources']),
        approvalsCount: _int(raw['approvals_count']) ?? 0,
        proposedScope: _scope(raw['proposed_scope']),
        agentProposed: raw['source'] == 'agent_proposed',
        days: _int(raw['days']),
        proposedVia: _str(_obj(raw['proposed_by'])['via']),
        proposedByAgentName: _str(_obj(raw['proposed_by'])['agent_name']),
      ),
];

GuestDigest parseDigest(Object? value) {
  final raw = _obj(value);
  final byRequester = raw['by_requester'];
  return GuestDigest(
    date: _str(raw['date']) ?? '',
    total: _int(raw['total']) ?? 0,
    byOutcome: {
      for (final entry in _obj(raw['by_outcome']).entries)
        entry.key: ?_int(entry.value),
    },
    byRequester: [
      for (final entry in byRequester is List ? byRequester : const [])
        if (_obj(entry) case final row when _str(row['pubkey']) != null)
          GuestDigestRequester(
            pubkey: _str(row['pubkey'])!,
            displayName: _str(row['display_name']),
            count: _int(row['count']) ?? 0,
          ),
    ],
    flaggedRequests: _int(raw['flagged_requests']) ?? 0,
    pendingApprovals: _int(raw['pending_approvals']) ?? 0,
    openSuggestions: _int(raw['open_suggestions']) ?? 0,
  );
}

GuestAdminOverview parseAdminOverview(Object? value) {
  final raw = _obj(value);
  final alerts = raw['alerts'];
  final suspended = raw['suspended_requesters'];
  return GuestAdminOverview(
    alerts: [
      for (final entry in alerts is List ? alerts : const [])
        if (_obj(entry) case final row
            when _str(row['alert_id']) != null && _str(row['kind']) != null)
          GuestAdminAlert(
            alertId: _str(row['alert_id'])!,
            kind: _str(row['kind'])!,
            severity: row['severity'] == 'high' ? 'high' : 'info',
            pattern: _str(_obj(row['payload'])['pattern']),
            requesterPubkey: _str(_obj(row['payload'])['requester_public_key']),
            count:
                _int(_obj(row['payload'])['owners']) ??
                _int(_obj(row['payload'])['agents']) ??
                _int(_obj(row['payload'])['high_flags_24h']),
            createdAt: _str(row['created_at']),
          ),
    ],
    suspended: [
      for (final entry in suspended is List ? suspended : const [])
        if (_obj(entry) case final row when _str(row['pubkey']) != null)
          GuestSuspendedRequester(
            pubkey: _str(row['pubkey'])!,
            userId: _str(row['user_id']),
            suspendedAt: _str(row['suspended_at']),
            reason: _str(row['reason']),
          ),
    ],
  );
}

// ── Derived views ──────────────────────────────────────────────────────────

/// Active (unexpired, unrevoked) grants, optionally for one agent.
List<GuestGrant> activeGrants(
  List<GuestGrant> grants, {
  String? guestEndpointId,
  DateTime? now,
}) {
  final at = now ?? DateTime.now();
  return [
    for (final grant in grants)
      if (grant.revokedAt == null &&
          (guestEndpointId == null ||
              grant.guestEndpointId == guestEndpointId) &&
          (grant.expiresAt == null ||
              (DateTime.tryParse(grant.expiresAt!)?.isAfter(at) ?? true)))
        grant,
  ];
}

/// Yesterday as YYYY-MM-DD in UTC, the digest's default day.
String defaultDigestDate({DateTime? now}) => digestDateString(
  (now ?? DateTime.now()).toUtc().subtract(const Duration(days: 1)),
);

/// A UTC calendar day as YYYY-MM-DD.
String digestDateString(DateTime day) {
  final utc = day.toUtc();
  String two(int n) => n.toString().padLeft(2, '0');
  return '${utc.year.toString().padLeft(4, '0')}-${two(utc.month)}-${two(utc.day)}';
}
