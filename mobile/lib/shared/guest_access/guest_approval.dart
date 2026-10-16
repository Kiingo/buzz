/// Typed views of the hosted guest-access route's owner approval records, and
/// the plain-language wording the owner sees.
///
/// This mirrors the desktop owner review (desktop/src/features/guest-access
/// `lib/wire.ts`, `lib/copy.ts`, `lib/approvalPreview.ts`) so both clients
/// show the same card. The route speaks snake_case and may add fields at any
/// time, so every reader here tolerates missing or unknown fields and never
/// throws on a malformed record.
library;

enum GrantScope { once, thread, personDays, questionKind, always }

const grantScopes = GrantScope.values;

GrantScope? grantScopeFromWire(Object? value) => switch (value) {
  'once' => GrantScope.once,
  'thread' => GrantScope.thread,
  'person_days' => GrantScope.personDays,
  'question_kind' => GrantScope.questionKind,
  'always' => GrantScope.always,
  _ => null,
};

String grantScopeToWire(GrantScope scope) => switch (scope) {
  GrantScope.once => 'once',
  GrantScope.thread => 'thread',
  GrantScope.personDays => 'person_days',
  GrantScope.questionKind => 'question_kind',
  GrantScope.always => 'always',
};

enum ApprovalDecision { approve, approveEdited, deny, denyAndBlock }

String approvalDecisionToWire(ApprovalDecision decision) => switch (decision) {
  ApprovalDecision.approve => 'approve',
  ApprovalDecision.approveEdited => 'approve_edited',
  ApprovalDecision.deny => 'deny',
  ApprovalDecision.denyAndBlock => 'deny_and_block',
};

/// How the route classifies who is asking (absent on older routes).
enum RequesterKind { test, newcomer, colleague, unlinked }

RequesterKind? _requesterKind(Object? value) => switch (value) {
  'test' => RequesterKind.test,
  'new' => RequesterKind.newcomer,
  'colleague' => RequesterKind.colleague,
  'unlinked' => RequesterKind.unlinked,
  _ => null,
};

class GuestRequester {
  const GuestRequester({
    required this.pubkey,
    this.displayName,
    this.linked = false,
    this.viaAgentPubkey,
    this.kind,
    this.isTest = false,
    this.linkedAt,
    this.priorRequestCount,
  });

  final String pubkey;
  final String? displayName;
  final bool linked;
  final String? viaAgentPubkey;

  /// `null` when the route predates requester classification.
  final RequesterKind? kind;

  /// A seeded test identity; always shown as such.
  final bool isTest;
  final String? linkedAt;

  /// Earlier requests this person sent the agent; `null` when unknown.
  final int? priorRequestCount;
}

class ApprovalPreviewSource {
  const ApprovalPreviewSource({required this.id, this.label});

  final String id;
  final String? label;
}

/// The route's plain-language preview of what approving does (absent on
/// older routes). [summary] is the route's sentence for the request as it
/// arrived.
class ApprovalPreview {
  const ApprovalPreview({
    this.agentName,
    this.recipientName,
    this.action,
    this.sources = const [],
    this.destination,
    this.audienceTotal,
    this.scope,
    this.summary,
  });

  final String? agentName;
  final String? recipientName;

  /// `read_and_reply` or `send_draft`.
  final String? action;
  final List<ApprovalPreviewSource> sources;

  /// `dm` or `channel`.
  final String? destination;
  final int? audienceTotal;
  final GrantScope? scope;
  final String? summary;
}

class GuestClassifier {
  const GuestClassifier({
    this.route,
    this.severity,
    this.categories = const [],
    this.topScores = const {},
  });

  final String? route;
  final String? severity;
  final List<String> categories;
  final Map<String, double> topScores;
}

class GuestApprovalChannel {
  const GuestApprovalChannel({
    this.id,
    this.type,
    this.name,
    this.audienceTotal,
  });

  final String? id;

  /// `dm` or `channel`.
  final String? type;
  final String? name;
  final int? audienceTotal;
}

class GuestApproval {
  const GuestApproval({
    required this.approvalId,
    this.agentGuestEndpointId,
    this.agentPubkey,
    this.agentDisplayName,
    this.source = 'guest_turn',
    this.guestTurnId,
    required this.requester,
    this.questionText,
    this.draftText,
    this.dataSources = const [],
    this.ownerOnlySources = const [],
    this.questionKind,
    this.classifier = const GuestClassifier(),
    this.reasonCodes = const [],
    this.requestedSources,
    this.requestableSources,
    this.channel = const GuestApprovalChannel(),
    this.state = 'pending',
    this.createdAt,
    this.expiresAt,
    this.decidedAt,
    this.approvalUrl,
    this.preview,
  });

  final String approvalId;
  final String? agentGuestEndpointId;
  final String? agentPubkey;
  final String? agentDisplayName;
  final String source;
  final String? guestTurnId;
  final GuestRequester requester;
  final String? questionText;
  final String? draftText;
  final List<String> dataSources;
  final List<String> ownerOnlySources;
  final String? questionKind;
  final GuestClassifier classifier;
  final List<String> reasonCodes;

  /// Owner-data requests: exactly what approval releases, or `[]` when the
  /// owner must choose from [requestableSources]. Both are `null` for every
  /// other approval.
  final List<String>? requestedSources;
  final List<String>? requestableSources;
  final GuestApprovalChannel channel;

  /// `pending`, `approved`, `denied`, `expired` or `cancelled`.
  final String state;
  final String? createdAt;
  final String? expiresAt;
  final String? decidedAt;
  final String? approvalUrl;
  final ApprovalPreview? preview;

  bool get isPending => state == 'pending';

  /// Whether this approval asks the owner to release private data to a
  /// re-run of the guest turn, rather than to publish a held draft.
  bool get isOwnerDataRequest => reasonCodes.contains('owner_data_requested');
}

Map<String, Object?> _obj(Object? value) =>
    value is Map ? value.cast<String, Object?>() : const {};

String? _str(Object? value) =>
    value is String && value.isNotEmpty ? value : null;

num? _num(Object? value) => value is num && value.isFinite ? value : null;

List<String> _strings(Object? value) => value is List
    ? [
        for (final entry in value)
          if (entry is String) entry,
      ]
    : const [];

const _approvalStates = {
  'pending',
  'approved',
  'denied',
  'expired',
  'cancelled',
};

GuestRequester parseRequester(Object? value) {
  final raw = _obj(value);
  final prior = _num(raw['prior_request_count']);
  return GuestRequester(
    pubkey: _str(raw['pubkey']) ?? '',
    displayName: _str(raw['display_name']),
    linked: raw['linked'] == true,
    viaAgentPubkey: _str(raw['via_agent_pubkey']),
    kind: _requesterKind(raw['kind']),
    isTest: raw['is_test'] == true || raw['kind'] == 'test',
    linkedAt: _str(raw['linked_at']),
    priorRequestCount:
        prior != null && prior == prior.roundToDouble() && prior >= 0
        ? prior.toInt()
        : null,
  );
}

ApprovalPreview? _parsePreview(Object? value) {
  if (value is! Map) return null;
  final raw = _obj(value);
  final sources = <ApprovalPreviewSource>[
    if (raw['sources'] case final List<Object?> list)
      for (final entry in list)
        if (_str(_obj(entry)['id']) case final id?)
          ApprovalPreviewSource(id: id, label: _str(_obj(entry)['label'])),
  ];
  final action = raw['action'];
  final destination = raw['destination'];
  return ApprovalPreview(
    agentName: _str(raw['agent_name']),
    recipientName: _str(raw['recipient_name']),
    action: action == 'read_and_reply' || action == 'send_draft'
        ? action as String
        : null,
    sources: sources,
    destination: destination == 'dm' || destination == 'channel'
        ? destination as String
        : null,
    audienceTotal: _num(raw['audience_total'])?.toInt(),
    scope: grantScopeFromWire(raw['scope']),
    summary: _str(raw['summary']),
  );
}

GuestClassifier _parseClassifier(Object? value) {
  final raw = _obj(value);
  final scores = <String, double>{};
  for (final entry in _obj(raw['top_scores'] ?? raw['scores']).entries) {
    final score = _num(entry.value);
    if (score != null) scores[entry.key] = score.toDouble();
  }
  return GuestClassifier(
    route: _str(raw['route']),
    severity: _str(raw['severity']),
    categories: _strings(raw['categories']),
    topScores: scores,
  );
}

/// Parse one approval record, or `null` when it has no approval id.
GuestApproval? parseGuestApproval(Object? value) {
  final raw = _obj(value);
  final approvalId = _str(raw['approval_id']);
  if (approvalId == null) return null;
  final agent = _obj(raw['agent']);
  final channel = _obj(raw['channel']);
  final channelType = channel['type'];
  final state = raw['state'];
  return GuestApproval(
    approvalId: approvalId,
    agentGuestEndpointId: _str(agent['guest_endpoint_id']),
    agentPubkey: _str(agent['pubkey']),
    agentDisplayName: _str(agent['display_name']),
    source: _str(raw['source']) ?? 'guest_turn',
    guestTurnId: _str(raw['guest_turn_id']),
    requester: parseRequester(raw['requester']),
    questionText: raw['question_text'] is String
        ? raw['question_text'] as String
        : null,
    draftText: raw['draft_text'] is String ? raw['draft_text'] as String : null,
    dataSources: _strings(raw['data_sources']),
    ownerOnlySources: _strings(raw['owner_only_sources']),
    questionKind: _str(raw['question_kind']),
    classifier: _parseClassifier(raw['classifier']),
    reasonCodes: _strings(raw['reason_codes']),
    requestedSources: raw['requested_sources'] is List
        ? _strings(raw['requested_sources'])
        : null,
    requestableSources: raw['requestable_sources'] is List
        ? _strings(raw['requestable_sources'])
        : null,
    channel: GuestApprovalChannel(
      id: _str(channel['id']),
      type: channelType == 'dm' || channelType == 'channel'
          ? channelType as String
          : null,
      name: _str(channel['name']),
      audienceTotal: _num(channel['audience_total'])?.toInt(),
    ),
    state: state is String && _approvalStates.contains(state)
        ? state
        : 'pending',
    createdAt: _str(raw['created_at']),
    expiresAt: _str(raw['expires_at']),
    decidedAt: _str(raw['decided_at']),
    approvalUrl: _str(raw['approval_url']),
    preview: _parsePreview(raw['preview']),
  );
}

/// Sources the owner may pick from when an owner-data request names none.
const defaultRequestableSources = [
  'calendar_events',
  'outlook_mailbox',
  'kiingo_files',
];

/// The sources the owner can release for an owner-data request, and whether
/// the owner must choose (the request named none).
({List<String> sources, bool mustChoose}) releasableSources(
  GuestApproval approval,
) {
  final requested = approval.requestedSources ?? const <String>[];
  if (requested.isNotEmpty) return (sources: requested, mustChoose: false);
  final requestable = approval.requestableSources;
  return (
    sources: requestable != null && requestable.isNotEmpty
        ? requestable
        : defaultRequestableSources,
    mustChoose: true,
  );
}

/// Initial selection: everything requested, or nothing when the owner must
/// pick.
List<String> initialSharedSources(List<String> sources, bool mustChoose) =>
    mustChoose ? <String>[] : [...sources];

// ── Wording ────────────────────────────────────────────────────────────────

String _humanize(String code) {
  final text = code.replaceAll(RegExp(r'[_-]+'), ' ').trim();
  return text.isEmpty ? code : '${text[0].toUpperCase()}${text.substring(1)}';
}

const _categoryReasons = {
  'extraction_attempt':
      'Looks like an attempt to pull out private information.',
  'impersonation': 'The sender may be pretending to be someone else.',
  'embedded_instructions':
      'The message contains instructions aimed at the agent itself.',
  'act_on_behalf': 'Asks the agent to act on your behalf.',
  'pressure': 'Uses urgency or pressure to push for an answer.',
  'needs_owner_data': 'Answering needs information only you can see.',
  'sensitive': 'Touches a sensitive topic.',
  'clear_attack': 'Reads as a clear attempt to misuse the agent.',
  'leak': "The draft may reveal something the asker shouldn't see.",
  'serious_leak': "The draft likely reveals something the asker shouldn't see.",
  'slow_extraction':
      'Over several messages, this conversation is steering toward private information.',
  'escalating': 'The requests in this thread are escalating.',
};

/// One plain-language sentence for a classifier category.
String classifierReason(String category) =>
    _categoryReasons[category] ?? '${_humanize(category)}.';

const _reasonCodes = {
  'owner_only_data':
      'The answer uses information only you can see, and no grant covers it.',
  'inbound_classifier': 'The safety check flagged the question.',
  'outbound_classifier': 'The safety check flagged the drafted answer.',
  'owner_data_requested':
      'Answering needs information only you can see. Nothing is shared unless you approve.',
  'owner_promise_guard':
      'Your agent offered to ask you, so this request was opened for you to decide.',
  'classifier_unavailable':
      'The safety check was unavailable, so this was held to be safe.',
};

/// Why a request was held for approval, in the owner's terms.
String approvalReason(String code) =>
    _reasonCodes[code] ?? '${_humanize(code)}.';

const _dataSources = {
  'memory': 'Memory',
  'communications': 'Email and chat history',
  'calendar_free_busy': 'Calendar free/busy',
  'calendar_details': 'Calendar event details',
  'clients': 'Clients',
  'sharepoint': 'SharePoint files',
  'hubspot': 'HubSpot',
  'shareable': 'Items you marked shareable',
  'owner_mailbox': 'Your mailbox',
  'calendar_events': 'Calendar events',
  'outlook_mailbox': 'Outlook mailbox',
  'kiingo_files': 'Kiingo files',
};

/// Owner-facing label for a data source.
String dataSourceLabel(String source) =>
    _dataSources[source] ?? _humanize(source);

const _dataSourceDescriptions = {
  'calendar_events':
      'Your meetings: titles, times, attendees, locations and notes.',
  'calendar_details':
      'Your meetings: titles, times, attendees, locations and notes.',
  'calendar_free_busy':
      "Only when you're free or busy, with no meeting details.",
  'outlook_mailbox':
      'Emails in your Outlook mailbox: senders, subjects and contents.',
  'owner_mailbox': 'Emails in your mailbox: senders, subjects and contents.',
  'kiingo_files': 'Documents and files in your Kiingo workspace.',
  'sharepoint': 'Documents and files in your SharePoint.',
  'communications': 'Your past emails and chat messages.',
  'memory': 'What your agent remembers from earlier conversations with you.',
  'clients': 'Client records you can see in Kiingo.',
  'hubspot': 'Contacts, companies and deals in HubSpot.',
  'shareable': 'Only the items you marked as shareable.',
};

/// One line on what sharing a source exposes, or `null` for a source this
/// app doesn't know yet (the label still shows).
String? dataSourceDescription(String source) => _dataSourceDescriptions[source];

/// Short label for who is asking, as the route classified them.
String requesterKindLabel(RequesterKind kind) => switch (kind) {
  RequesterKind.test => 'Test',
  RequesterKind.newcomer => 'New',
  RequesterKind.colleague => 'Colleague',
  RequesterKind.unlinked => 'Not linked',
};

String _ordinal(int n) {
  final rem100 = n % 100;
  final suffix = rem100 >= 11 && rem100 <= 13
      ? 'th'
      : switch (n % 10) {
          1 => 'st',
          2 => 'nd',
          3 => 'rd',
          _ => 'th',
        };
  return '$n$suffix';
}

/// "First request" or "3rd request", from the count of earlier requests.
String requestCountLabel(int priorRequestCount) => priorRequestCount == 0
    ? 'First request'
    : '${_ordinal(priorRequestCount + 1)} request';

/// "linked today", "linked 3 days ago", ...; `null` for a bad timestamp.
String? linkedAgoLabel(String linkedAt, {DateTime? now}) {
  final at = DateTime.tryParse(linkedAt);
  if (at == null) return null;
  final elapsed = (now ?? DateTime.now()).difference(at);
  final days = elapsed.isNegative ? 0 : elapsed.inDays;
  if (days == 0) return 'linked today';
  if (days == 1) return 'linked yesterday';
  if (days < 30) return 'linked $days days ago';
  final months = days ~/ 30;
  if (months < 12) {
    return 'linked $months ${months == 1 ? 'month' : 'months'} ago';
  }
  final years = days ~/ 365;
  return 'linked $years ${years == 1 ? 'year' : 'years'} ago';
}

/// Requester name, or a short pubkey when the person hasn't linked.
String requesterLabel(GuestRequester requester) {
  final name = requester.displayName;
  if (name != null) return name;
  final pubkey = requester.pubkey;
  if (pubkey.isEmpty) return 'Someone';
  return pubkey.length > 12
      ? '${pubkey.substring(0, 8)}…${pubkey.substring(pubkey.length - 4)}'
      : pubkey;
}

/// The optional details after the requester's name: linked-ago, request
/// count and whether they asked through their own agent.
List<String> requesterDetails(GuestRequester requester, {DateTime? now}) => [
  if (requester.linked && requester.linkedAt != null)
    ?linkedAgoLabel(requester.linkedAt!, now: now),
  if (requester.priorRequestCount != null)
    requestCountLabel(requester.priorRequestCount!),
  if (requester.viaAgentPubkey != null) 'asked through their agent',
];

/// The route classification badge, if any. TEST has its own badge and
/// "not linked" is already shown by the link-state badge.
String? requesterKindBadge(GuestRequester requester) {
  final kind = requester.kind;
  if (kind == null ||
      kind == RequesterKind.test ||
      kind == RequesterKind.unlinked) {
    return null;
  }
  return requesterKindLabel(kind);
}

/// Grant scope label shown in the picker.
String scopeLabel(GrantScope scope, {int? days}) => switch (scope) {
  GrantScope.once => 'Just this once',
  GrantScope.thread => 'For this thread',
  GrantScope.personDays =>
    days != null ? 'This person for $days days' : 'This person for a while',
  GrantScope.questionKind => 'This kind of question from this person',
  GrantScope.always => 'Always for this person',
};

String scopeHint(GrantScope scope) => switch (scope) {
  GrantScope.once => "Only this answer. They'll need your approval next time.",
  GrantScope.thread =>
    'Answers like this in this thread go out without asking you.',
  GrantScope.personDays =>
    'This person can get answers from the same data for a while.',
  GrantScope.questionKind =>
    'Questions of this kind from this person go out without asking you.',
  GrantScope.always =>
    'This person can always get answers from the same data. New kinds of questions flagged by the safety check still come to you.',
};

const defaultGrantDays = 7;
const grantDayOptions = [1, 7, 30, 90];

typedef GrantChoice = ({GrantScope scope, int days});

/// The `grant` body for a decision, or `null` for a one-time approval.
Map<String, Object>? grantForChoice(GrantChoice choice) {
  if (choice.scope == GrantScope.once) return null;
  return choice.scope == GrantScope.personDays
      ? {'scope': 'person_days', 'days': choice.days}
      : {'scope': grantScopeToWire(choice.scope)};
}

/// Percent text for a 0..1 classifier score.
String scorePercent(double score) => '${(score.clamp(0, 1) * 100).round()}%';

/// Text shown once an approval is no longer pending.
String decidedStateText(GuestApproval approval) {
  if (approval.state == 'approved' && approval.isOwnerDataRequest) {
    return 'Approved. Your agent answered using only what you shared.';
  }
  return switch (approval.state) {
    'approved' => 'Approved. The reply has been sent.',
    'denied' => 'Declined. They were told you declined to share that.',
    'expired' => 'This request expired before it was decided.',
    'cancelled' => 'This request was cancelled.',
    _ => 'This request is no longer pending.',
  };
}

// ── Preview sentence ───────────────────────────────────────────────────────

const _ownerSourcePhrases = {
  'calendar_events': 'your calendar events',
  'calendar_details': 'your calendar event details',
  'calendar_free_busy': "when you're free or busy",
  'outlook_mailbox': 'your Outlook mailbox',
  'owner_mailbox': 'your mailbox',
  'kiingo_files': 'your Kiingo files',
  'sharepoint': 'your SharePoint files',
  'communications': 'your email and chat history',
  'memory': 'what it remembers about you',
  'hubspot': 'your HubSpot records',
  'clients': 'your client records',
  'shareable': 'the items you marked shareable',
};

String _joinList(List<String> parts) {
  if (parts.length <= 1) return parts.isEmpty ? '' : parts.first;
  return '${parts.sublist(0, parts.length - 1).join(', ')} and ${parts.last}';
}

String _scopePhrase(GrantScope scope, int days) => switch (scope) {
  GrantScope.once => 'once',
  GrantScope.thread => 'and keep answering in this thread without asking you',
  GrantScope.personDays =>
    'and keep answering them for $days days without asking you',
  GrantScope.questionKind =>
    'and keep answering questions like this from them without asking you',
  GrantScope.always => 'and keep answering them from now on without asking you',
};

/// The sentence shown right above an approval's buttons: what pressing the
/// primary button does, in the owner's terms. It follows the owner's current
/// choices (sources ticked, grant scope, writing the reply themselves), so it
/// never describes something the buttons won't do. Without the route's
/// `preview` block (older routes) there is no sentence.
String? approvalPreviewSentence(
  GuestApproval approval, {
  required List<String> sharedSources,
  required GrantChoice grant,
  required bool writingReply,
}) {
  final preview = approval.preview;
  if (preview == null) return null;
  final agent = preview.agentName ?? approval.agentDisplayName ?? 'Your agent';
  final recipient =
      preview.recipientName ?? approval.requester.displayName ?? 'them';
  final destination = preview.destination ?? approval.channel.type;
  final audience = preview.audienceTotal ?? approval.channel.audienceTotal;
  final channelName = approval.channel.name;
  final where = destination == 'channel'
      ? 'in ${channelName != null ? '#$channelName' : 'the channel'}'
            '${audience != null && audience > 1 ? ', where $audience people can see it' : ''}'
      : 'in this DM';

  if (writingReply) {
    return preview.action == 'read_and_reply'
        ? "Your reply goes to $recipient $where. $agent won't read anything."
        : 'Your edited reply goes to $recipient $where.';
  }
  if (preview.action != 'read_and_reply') return preview.summary;

  final scope = _scopePhrase(grant.scope, grant.days);
  final tail = grant.scope == GrantScope.once ? ', $scope.' : ' $scope.';
  if (sharedSources.isEmpty) {
    return 'Choose what $agent may read before it replies to $recipient $where$tail';
  }
  final serverLabels = {
    for (final source in preview.sources)
      if (source.label != null) source.id: source.label!,
  };
  final read = _joinList([
    for (final id in sharedSources)
      serverLabels[id] ??
          _ownerSourcePhrases[id] ??
          'your ${dataSourceLabel(id).toLowerCase()}',
  ]);
  return '$agent will read $read and reply to $recipient $where$tail';
}
