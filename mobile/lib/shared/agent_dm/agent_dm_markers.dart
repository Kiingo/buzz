/// Agent DM markers v1: the signed tags an agent runtime adds to events in a
/// 1:1 DM (`docs/agent-dm-markers.md`). Every reader here is strict: a
/// missing, duplicated or malformed marker yields null, and the event then
/// renders as the plain message its content already is.
library;

/// Kind of the quiet marker events (mirrors, dividers, listings, states).
const agentDmQuietKind = 40002;

/// Kind of agent replies that carry a question card or action buttons.
const agentDmReplyKind = 9;

/// Most items a sessions listing shows.
const agentDmMaxSessionItems = 20;

/// Most action buttons under one message.
const agentDmMaxActions = 3;

final _hexPubkey = RegExp(r'^[0-9a-f]{64}$');
final _surface = RegExp(r'^[a-z][a-z0-9_-]{0,31}$');
final _unsigned = RegExp(r'^(0|[1-9][0-9]{0,15})$');
final _mirrorTime = RegExp(r'^\d{1,12}$');

/// Session ids go into `/sessions load <id>`, so they never hold whitespace.
final _sessionId = RegExp(r'^[A-Za-z0-9._:\-]{1,128}$');

/// Whether markers are honoured for an event: only in a DM, and only when the
/// signer is a member of that DM.
bool agentDmMarkersApply({
  required bool isDm,
  required String signerPubkey,
  required Iterable<String> memberPubkeys,
}) {
  if (!isDm) return false;
  final signer = signerPubkey.trim().toLowerCase();
  if (!_hexPubkey.hasMatch(signer)) return false;
  return normalizeAgentDmMembers(memberPubkeys).contains(signer);
}

/// Lowercase 64-hex member keys; anything else is dropped.
Set<String> normalizeAgentDmMembers(Iterable<String> memberPubkeys) => {
  for (final pubkey in memberPubkeys)
    if (_hexPubkey.hasMatch(pubkey.trim().toLowerCase()))
      pubkey.trim().toLowerCase(),
};

/// Whether [pubkey] is a lowercase-normalisable 64-hex key.
bool isAgentDmHexPubkey(String pubkey) =>
    _hexPubkey.hasMatch(pubkey.trim().toLowerCase());

List<List<String>> _named(List<List<String>> tags, String name) => [
  for (final tag in tags)
    if (tag.isNotEmpty && tag[0] == name) tag,
];

/// The single tag named [name] with exactly [length] elements, or null when it
/// is missing, repeated or the wrong shape.
List<String>? _single(List<List<String>> tags, String name, int length) {
  final found = _named(tags, name);
  if (found.length != 1 || found.single.length != length) return null;
  return found.single;
}

int? _seconds(String value) =>
    _unsigned.hasMatch(value) ? int.tryParse(value) : null;

bool? _flag(String value) => switch (value) {
  '1' => true,
  '0' => false,
  _ => null,
};

bool _bounded(String value, int max, {bool allowEmpty = false}) =>
    (allowEmpty || value.trim().isNotEmpty) && value.length <= max;

/// Who wrote the mirrored message on its own surface.
enum AgentDmMirrorRole {
  /// The person the agent works for.
  requester,

  /// The agent itself.
  agent,
}

/// `buzz-mirror`: a message from another surface copied in as history.
class AgentDmMirror {
  /// Surface the original lives on, such as `email` or `teams`.
  final String surface;

  /// Opaque id of the original on its surface.
  final String sourceId;

  /// The original message's time, in Unix seconds.
  final int originalAt;

  /// Who wrote the original.
  final AgentDmMirrorRole role;

  /// The claimed author key; trusted only after the membership check.
  final String authorPubkey;

  /// The claimed author name. Never displayed as an author.
  final String authorName;

  /// The email subject, when present and well formed.
  final String? subject;

  const AgentDmMirror({
    required this.surface,
    required this.sourceId,
    required this.originalAt,
    required this.role,
    required this.authorPubkey,
    required this.authorName,
    this.subject,
  });

  /// The badge text: "via email", "via Kiingo Tasks", or `via <surface>`.
  String get badgeLabel => 'via ${agentDmMirrorSurfaceLabel(surface)}';

  /// The member shown as the author, or null to show the signer.
  ///
  /// Only a requester mirror whose key is 64-hex, differs from the signer and
  /// belongs to this DM takes another author. A claimed name never does.
  String? authorOverride({
    required String signerPubkey,
    required Iterable<String> memberPubkeys,
  }) {
    if (role != AgentDmMirrorRole.requester) return null;
    final author = authorPubkey.trim().toLowerCase();
    if (!_hexPubkey.hasMatch(author)) return null;
    if (author == signerPubkey.trim().toLowerCase()) return null;
    return normalizeAgentDmMembers(memberPubkeys).contains(author)
        ? author
        : null;
  }
}

/// The surface a mirror came from, as a noun: "Kiingo Tasks", "the
/// Companion", "email", or the surface itself. Same labels as desktop's
/// `mirrorSurfaceLabel`.
String agentDmMirrorSurfaceLabel(String surface) => switch (surface) {
  'email' => 'email',
  'teams' => 'Teams',
  'sms' => 'SMS',
  'web' => 'web',
  'voice' => 'voice call',
  'tasks' => 'Kiingo Tasks',
  'companion' => 'the Companion',
  'ask' => 'Kiingo Ask',
  _ => surface,
};

/// Reads `buzz-mirror`, `buzz-mirror-author` and the optional `subject`, the
/// same rule as desktop's `parseMirror` (shared vectors:
/// `test-fixtures/mirror-display.json`). It fails closed to a relayed line:
///
/// - the first `buzz-mirror` tag must carry a valid surface, source id and
///   time, otherwise this is not a mirror and the event is a plain message;
/// - a missing, repeated or malformed `buzz-mirror-author` tag (not exactly
///   four elements, an unknown role, a key that is neither empty nor 64-hex)
///   reads as an unattributed requester mirror, so the line shows relayed by
///   its signer and never as the signer's own words or as a member's;
/// - a missing, repeated or malformed subject is dropped and the mirror kept.
AgentDmMirror? readAgentDmMirror(List<List<String>> tags) {
  final mirrors = _named(tags, 'buzz-mirror');
  if (mirrors.isEmpty || mirrors.first.length < 4) return null;
  final mirror = mirrors.first;
  final surface = mirror[1];
  final sourceId = mirror[2];
  // Same bound as desktop's mirror time: 1 to 12 digits.
  final originalAt = _mirrorTime.hasMatch(mirror[3])
      ? int.parse(mirror[3])
      : null;
  if (!_surface.hasMatch(surface) ||
      !_bounded(sourceId, 256) ||
      originalAt == null) {
    return null;
  }
  final (role, authorPubkey, authorName) = _mirrorAuthor(tags);
  final subject = _single(tags, 'subject', 2)?[1];
  return AgentDmMirror(
    surface: surface,
    sourceId: sourceId,
    originalAt: originalAt,
    role: role,
    authorPubkey: authorPubkey,
    authorName: authorName,
    subject: subject != null && _bounded(subject, 200) ? subject.trim() : null,
  );
}

/// The mirror author as (role, lowercase key or empty, claimed name), or an
/// unattributed requester when the tag is missing, repeated or malformed.
(AgentDmMirrorRole, String, String) _mirrorAuthor(List<List<String>> tags) {
  const unattributed = (AgentDmMirrorRole.requester, '', '');
  final author = _single(tags, 'buzz-mirror-author', 4);
  if (author == null) return unattributed;
  final role = switch (author[1]) {
    'requester' => AgentDmMirrorRole.requester,
    'agent' => AgentDmMirrorRole.agent,
    _ => null,
  };
  if (role == null) return unattributed;
  final key = author[2].toLowerCase();
  if (key.isNotEmpty && !_hexPubkey.hasMatch(key)) return unattributed;
  return (role, key, author[3]);
}

/// Which way a recorded call went.
enum AgentDmCallDirection {
  /// The person called the agent.
  inbound,

  /// The agent called the person.
  outbound,
}

/// `buzz-call`: a voice call's record card, carried with a `voice` mirror.
class AgentDmCall {
  final AgentDmCallDirection direction;

  /// Call length in seconds.
  final int durationS;

  /// Where the call happened, such as `web` or `buzz_huddle`.
  final String surface;

  const AgentDmCall({
    required this.direction,
    required this.durationS,
    required this.surface,
  });

  /// "Call · N min", rounded and never below one minute.
  String get title {
    final minutes = (durationS / 60).round();
    return 'Call · ${minutes < 1 ? 1 : minutes} min';
  }
}

/// Reads `["buzz-call", direction, durationS, surface]` from a `voice`
/// mirror. Anything else is not a call card (it renders as the mirror).
AgentDmCall? readAgentDmCall(List<List<String>> tags) {
  final mirror = readAgentDmMirror(tags);
  final tag = _single(tags, 'buzz-call', 4);
  if (mirror == null || mirror.surface != 'voice' || tag == null) return null;
  final direction = switch (tag[1]) {
    'inbound' => AgentDmCallDirection.inbound,
    'outbound' => AgentDmCallDirection.outbound,
    _ => null,
  };
  final durationS = RegExp(r'^\d{1,9}$').hasMatch(tag[2])
      ? int.parse(tag[2])
      : null;
  if (direction == null || durationS == null || !_surface.hasMatch(tag[3])) {
    return null;
  }
  return AgentDmCall(
    direction: direction,
    durationS: durationS,
    surface: tag[3],
  );
}

/// What a session divider records.
enum AgentDmSessionAction {
  /// A fresh native session started.
  started,

  /// An earlier session was loaded.
  loaded,

  /// The conversation continues on another harness.
  switched,
}

/// `buzz-session`: the conversation moved to another native session.
class AgentDmSessionDivider {
  /// What happened.
  final AgentDmSessionAction action;

  /// The session id, or empty when the agent did not name one.
  final String sessionId;

  const AgentDmSessionDivider({required this.action, required this.sessionId});

  /// "New session" for `new` and `switch`, "Earlier session loaded" for
  /// `load`.
  String get label => action == AgentDmSessionAction.loaded
      ? 'Earlier session loaded'
      : 'New session';
}

/// Reads a `buzz-session` divider.
AgentDmSessionDivider? readAgentDmSessionDivider(List<List<String>> tags) {
  final tag = _single(tags, 'buzz-session', 3);
  if (tag == null) return null;
  final action = switch (tag[1]) {
    'new' => AgentDmSessionAction.started,
    'load' => AgentDmSessionAction.loaded,
    'switch' => AgentDmSessionAction.switched,
    _ => null,
  };
  final sessionId = tag[2];
  if (action == null ||
      (sessionId.isNotEmpty && !_sessionId.hasMatch(sessionId))) {
    return null;
  }
  return AgentDmSessionDivider(action: action, sessionId: sessionId);
}

/// One `buzz-session-item` in a listing.
class AgentDmSessionItem {
  /// Id sent back in `/sessions load <id>`.
  final String sessionId;

  /// Whether this is the session the conversation is on now.
  final bool isCurrent;

  /// When the session started, in Unix seconds.
  final int startedAt;

  /// When the session was last active, in Unix seconds.
  final int lastActiveAt;

  /// Short title the agent gave the session.
  final String title;

  /// Whether the agent can load this session.
  final bool loadable;

  /// Number of turns in the session.
  final int turnCount;

  const AgentDmSessionItem({
    required this.sessionId,
    required this.isCurrent,
    required this.startedAt,
    required this.lastActiveAt,
    required this.title,
    required this.loadable,
    required this.turnCount,
  });
}

/// `buzz-sessions`: the agent's answer to `/sessions`.
class AgentDmSessionsListing {
  /// The `/sessions` request this answers, or empty.
  final String requestId;

  /// Up to [agentDmMaxSessionItems] sessions, newest first.
  final List<AgentDmSessionItem> items;

  const AgentDmSessionsListing({required this.requestId, required this.items});
}

AgentDmSessionItem? _sessionItem(List<String> tag) {
  if (tag.length != 8) return null;
  final sessionId = tag[1];
  final current = switch (tag[2]) {
    'current' => true,
    'previous' => false,
    _ => null,
  };
  final startedAt = _seconds(tag[3]);
  final lastActiveAt = _seconds(tag[4]);
  final title = tag[5];
  final loadable = _flag(tag[6]);
  final turnCount = _seconds(tag[7]);
  if (!_sessionId.hasMatch(sessionId) ||
      current == null ||
      startedAt == null ||
      lastActiveAt == null ||
      title.length > 200 ||
      loadable == null ||
      turnCount == null) {
    return null;
  }
  return AgentDmSessionItem(
    sessionId: sessionId,
    isCurrent: current,
    startedAt: startedAt,
    lastActiveAt: lastActiveAt,
    title: title,
    loadable: loadable,
    turnCount: turnCount,
  );
}

/// Reads a `buzz-sessions` listing. Malformed items are dropped; the first
/// [agentDmMaxSessionItems] well-formed items are kept in order.
AgentDmSessionsListing? readAgentDmSessionsListing(List<List<String>> tags) {
  final tag = _single(tags, 'buzz-sessions', 2);
  if (tag == null || !_bounded(tag[1], 128, allowEmpty: true)) return null;
  final items = <AgentDmSessionItem>[];
  final seen = <String>{};
  for (final itemTag in _named(tags, 'buzz-session-item')) {
    final item = _sessionItem(itemTag);
    if (item == null || !seen.add(item.sessionId)) continue;
    items.add(item);
    if (items.length == agentDmMaxSessionItems) break;
  }
  return AgentDmSessionsListing(
    requestId: tag[1],
    items: List.unmodifiable(items),
  );
}

/// One option of a question.
class AgentDmQuestionOption {
  /// The label, sent back verbatim as the answer.
  final String label;

  /// Optional longer description.
  final String description;

  const AgentDmQuestionOption({required this.label, required this.description});
}

/// One `buzz-question-item` with its options.
class AgentDmQuestion {
  /// Question id, unique within the card.
  final String qid;

  /// The question text.
  final String text;

  /// A short header, or empty.
  final String header;

  /// Whether several options may be chosen.
  final bool multi;

  /// Whether a typed "Other" answer is allowed.
  final bool allowOther;

  /// Options in order.
  final List<AgentDmQuestionOption> options;

  const AgentDmQuestion({
    required this.qid,
    required this.text,
    required this.header,
    required this.multi,
    required this.allowOther,
    required this.options,
  });
}

/// `buzz-question`: a question card under an agent reply.
class AgentDmQuestionCard {
  /// The ask id answers and state events refer to.
  final String askId;

  /// One to four questions, in order.
  final List<AgentDmQuestion> questions;

  const AgentDmQuestionCard({required this.askId, required this.questions});

  /// A single single-select question sends on tap.
  bool get sendsOnTap => questions.length == 1 && !questions.single.multi;
}

/// Reads a question card. Any malformed part discards the whole card, so a
/// person never answers a question the agent did not ask.
AgentDmQuestionCard? readAgentDmQuestionCard(List<List<String>> tags) {
  final ask = _single(tags, 'buzz-question', 2);
  if (ask == null || !_bounded(ask[1], 128)) return null;
  final itemTags = _named(tags, 'buzz-question-item');
  if (itemTags.isEmpty || itemTags.length > 4) return null;
  final order = <String>[];
  final heads = <String, List<String>>{};
  for (final tag in itemTags) {
    if (tag.length != 6) return null;
    final qid = tag[1];
    if (!_bounded(qid, 64) || heads.containsKey(qid)) return null;
    if (!_bounded(tag[2], 2000) || !_bounded(tag[3], 64, allowEmpty: true)) {
      return null;
    }
    if (_flag(tag[4]) == null || _flag(tag[5]) == null) return null;
    heads[qid] = tag;
    order.add(qid);
  }
  final options = {for (final qid in order) qid: <AgentDmQuestionOption>[]};
  for (final tag in _named(tags, 'buzz-question-option')) {
    if (tag.length != 4) return null;
    final list = options[tag[1]];
    if (list == null ||
        !_bounded(tag[2], 200) ||
        !_bounded(tag[3], 500, allowEmpty: true) ||
        list.any((option) => option.label == tag[2])) {
      return null;
    }
    list.add(AgentDmQuestionOption(label: tag[2], description: tag[3]));
    if (list.length > 8) return null;
  }
  final questions = <AgentDmQuestion>[];
  for (final qid in order) {
    final head = heads[qid]!;
    final allowOther = _flag(head[5])!;
    final questionOptions = options[qid]!;
    // A question with nothing to tap and nothing to type is unanswerable.
    if (questionOptions.isEmpty && !allowOther) return null;
    questions.add(
      AgentDmQuestion(
        qid: qid,
        text: head[2],
        header: head[3],
        multi: _flag(head[4])!,
        allowOther: allowOther,
        options: List.unmodifiable(questionOptions),
      ),
    );
  }
  return AgentDmQuestionCard(
    askId: ask[1],
    questions: List.unmodifiable(questions),
  );
}

/// The terminal state a `buzz-question-state` event gives a card.
enum AgentDmQuestionStateValue {
  /// The ask was answered.
  answered,

  /// The ask is closed; any state other than `answered` counts as closed.
  closed,
}

/// `buzz-question-state`: closes a question card.
class AgentDmQuestionState {
  /// The ask this closes.
  final String askId;

  /// The new state.
  final AgentDmQuestionStateValue state;

  const AgentDmQuestionState({required this.askId, required this.state});
}

/// Reads a `buzz-question-state` event's marker.
AgentDmQuestionState? readAgentDmQuestionState(List<List<String>> tags) {
  final tag = _single(tags, 'buzz-question-state', 3);
  if (tag == null || !_bounded(tag[1], 128) || tag[2].trim().isEmpty) {
    return null;
  }
  return AgentDmQuestionState(
    askId: tag[1],
    state: tag[2] == 'answered'
        ? AgentDmQuestionStateValue.answered
        : AgentDmQuestionStateValue.closed,
  );
}

/// The ask id a `buzz-answer` message answers, or null.
String? readAgentDmAnswerAskId(List<List<String>> tags) {
  final found = _named(tags, 'buzz-answer');
  if (found.length != 1 || found.single.length < 2) return null;
  final askId = found.single[1];
  return _bounded(askId, 128) ? askId : null;
}

/// One `buzz-action` button.
class AgentDmAction {
  /// Stable id of the action, such as `retry`.
  final String actionId;

  /// Button label.
  final String label;

  /// Text sent as the message content when tapped.
  final String sendText;

  /// Whether this is the primary button.
  final bool primary;

  /// Opaque ref minted by the agent runtime for this action.
  final String ref;

  const AgentDmAction({
    required this.actionId,
    required this.label,
    required this.sendText,
    required this.primary,
    required this.ref,
  });
}

/// Reads up to [agentDmMaxActions] well-formed `buzz-action` buttons, in tag
/// order. Malformed tags are skipped.
List<AgentDmAction> readAgentDmActions(List<List<String>> tags) {
  final actions = <AgentDmAction>[];
  for (final tag in _named(tags, 'buzz-action')) {
    if (tag.length != 6) continue;
    final primary = switch (tag[4]) {
      'primary' => true,
      'secondary' => false,
      _ => null,
    };
    if (!_bounded(tag[1], 64) ||
        !_bounded(tag[2], 64) ||
        !_bounded(tag[3], 2000) ||
        primary == null ||
        !_bounded(tag[5], 512)) {
      continue;
    }
    actions.add(
      AgentDmAction(
        actionId: tag[1],
        label: tag[2],
        sendText: tag[3],
        primary: primary,
        ref: tag[5],
      ),
    );
    if (actions.length == agentDmMaxActions) break;
  }
  return List.unmodifiable(actions);
}

/// The ref a tapped action message carries, or null.
String? readAgentDmActionRef(List<List<String>> tags) {
  final tag = _single(tags, 'buzz-action-ref', 2);
  return tag != null && _bounded(tag[1], 512) ? tag[1] : null;
}

final _tapMessageId = RegExp(r'^[0-9a-fA-F]{64}$');

/// The tags a tapped action sends: the ref, and `['e', <message id>, '',
/// 'mention']` naming the message the button was on (a mention marker, so
/// the tap stays top-level, never a thread reply). Kiingo checks that
/// message is its own notice that carried this button, so a lookalike from
/// an agent's key can't borrow a real ask's ref (79
/// MUST-79-LEND-CONSENT-TAP-NOT-BOUND-TO-NOTICE). A message without a relay
/// id yet sends the ref alone.
List<List<String>> agentDmActionRefTags(
  AgentDmAction action, {
  required String messageId,
}) => [
  ['buzz-action-ref', action.ref],
  if (_tapMessageId.hasMatch(messageId))
    ['e', messageId.toLowerCase(), '', 'mention'],
];

final _surfaceUuid = RegExp(
  r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
  caseSensitive: false,
);
final _surfaceRevision = RegExp(r'^[1-9][0-9]{0,8}$');

/// `buzz-surface`: an agent card the message points at (§7).
class AgentDmSurface {
  /// The card's lowercase UUID on the agent host.
  final String surfaceId;

  /// The card's revision when the message was sent.
  final int revision;

  const AgentDmSurface({required this.surfaceId, required this.revision});
}

/// Reads exactly one `["buzz-surface", <uuid>, <revision>]` of exactly three
/// elements. More than one, or a malformed one, leaves the message plain.
AgentDmSurface? readAgentDmSurface(List<List<String>> tags) {
  final named = _named(tags, 'buzz-surface');
  if (named.length != 1 || named.single.length != 3) return null;
  final tag = named.single;
  if (!_surfaceUuid.hasMatch(tag[1]) || !_surfaceRevision.hasMatch(tag[2])) {
    return null;
  }
  return AgentDmSurface(
    surfaceId: tag[1].toLowerCase(),
    revision: int.parse(tag[2]),
  );
}
