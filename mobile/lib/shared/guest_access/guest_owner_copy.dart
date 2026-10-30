/// Plain-language wording for the owner's guest-access settings, matching
/// desktop (desktop/src/features/guest-access `lib/copy.ts`,
/// `lib/adminCopy.ts` and the Access dialog tabs). The route returns stable
/// machine codes; owners see sentences. Unknown codes fall back to a
/// humanized code so a new server value is still readable, except in a
/// grant's question kind and data sources, which a proposer chooses: there an
/// unknown code is quoted ([questionKindWords], [grantSourceLabel]).
library;

import 'guest_approval.dart';
import 'guest_inert_text.dart';
import 'guest_owner_records.dart';

String _humanize(String code) {
  final text = code.replaceAll(RegExp(r'[_-]+'), ' ').trim();
  return text.isEmpty ? code : '${text[0].toUpperCase()}${text.substring(1)}';
}

const _outcomes = {
  'answered': 'Answered',
  'held': 'Waiting for you',
  'approved': 'Approved',
  'denied': 'Declined',
  'blocked': 'Blocked',
  'refused': 'Refused',
  'rate_limited': 'Rate limited',
};

/// Short label for an access-log outcome.
String outcomeLabel(String outcome) => _outcomes[outcome] ?? _humanize(outcome);

/// Visual tone of an outcome badge.
enum GuestTone { neutral, positive, warning, danger }

/// Tone for an access-log outcome badge.
GuestTone outcomeTone(String outcome) => switch (outcome) {
  'answered' || 'approved' => GuestTone.positive,
  'held' || 'rate_limited' => GuestTone.warning,
  'blocked' || 'denied' || 'refused' => GuestTone.danger,
  _ => GuestTone.neutral,
};

/// Tier label for the access log (tier 3 is never available, so never shown).
String? tierLabel(int? tier) => switch (tier) {
  0 => 'Unlinked',
  1 => 'Shared info',
  2 => 'Needs approval',
  _ => null,
};

/// Who can reach an agent, from the access mode the agent last reported.
String respondToSummary(String? respondTo) => switch (respondTo) {
  'anyone' => 'Anyone in the community can ask.',
  'allowlist' => 'The people you selected can ask.',
  'nobody' => 'Nobody can ask, including you.',
  _ => 'Only you and your own agents can ask.',
};

/// The owner-exclusive data sources: the only ids the server joins into a
/// question kind. Mirrors Kiingo's single source of truth,
/// BUZZ_GUEST_OWNER_ONLY_SOURCES in Kiingo/kiingo
/// packages/brain-public-ts-contracts/src/agents/buzz-guest-owner-sources.ts
/// (the `owner_only_requires_grant` sources of the kiingo-mcp guest policy),
/// and desktop `GUEST_OWNER_ONLY_SOURCES` (lib/copy.ts), whose
/// accessTabs.test.mjs checks this list stays equal. Change all three
/// together.
const guestOwnerOnlySources = <String>[
  'calendar_events',
  'outlook_mailbox',
  'kiingo_files',
];
const _questionKindMax = 200;
const _questionKindMaxSources = 10;
final _questionKindPlus = RegExp(r'\s*\+\s*');
final _questionKindSpaces = RegExp(r'\s+', unicode: true);
final _questionKindEdges = RegExp(r'^[\s,]+|[\s,]+$');
const _questionKindShownMax = 80;

/// A question kind in plain words, worded as the Kiingo approvals page words
/// it (`questionKindText`,
/// apps/agent-ui/src/pages/buzz/buzz-guest-question-kind.ts). Plain only in
/// the server's exact shape (`questionKindOf`): `[sensitive:]general`, or
/// sources joined by `+` in ascending order, no repeats, every one in
/// [guestOwnerOnlySources]:
/// "general questions", "sensitive questions that need your calendar events,
/// outlook mailbox". The kind is agent-influenced (79, 2026-10-30), so
/// anything else, including a list with one unknown part such as
/// "ross_approved_this", is someone's own text: shown quoted, one line, no
/// invisible characters, separators made human, capped, never blank. Mirrors
/// desktop `questionKindWords` (lib/copy.ts).
String questionKindWords(String? questionKind) {
  if (questionKind == null || questionKind.isEmpty) {
    return 'this kind of question';
  }
  const prefix = 'sensitive:';
  final sensitive = questionKind.startsWith(prefix);
  final base = sensitive ? questionKind.substring(prefix.length) : questionKind;
  final adjective = sensitive ? 'sensitive ' : '';
  if (questionKind.length <= _questionKindMax) {
    if (base == 'general') return '${adjective}general questions';
    final sources = base.split('+');
    // Known sources in ascending order with no repeats: `questionKindOf`
    // sorts a set, so anything else is not the server's shape.
    var shaped = sources.length <= _questionKindMaxSources;
    for (var i = 0; shaped && i < sources.length; i++) {
      shaped =
          guestOwnerOnlySources.contains(sources[i]) &&
          (i == 0 || sources[i].compareTo(sources[i - 1]) > 0);
    }
    if (shaped) {
      final words = sources.map((source) => source.replaceAll('_', ' '));
      return '${adjective}questions that need your ${words.join(', ')}';
    }
  }
  final text = _inertOwnText(questionKind);
  return text == null ? 'this kind of question' : '“$text” questions';
}

/// Someone's own text, made inert for quoting: one line, no invisible or
/// quote characters (guest_inert_text.dart, so it cannot close its quote),
/// separators made human, capped by code point. Null when nothing is left.
String? _inertOwnText(String value) {
  final shown = value
      .replaceAll(guestInvisibleChars, ' ')
      .replaceAll(guestQuoteChars, ' ')
      .replaceAll('_', ' ')
      .replaceAll(_questionKindPlus, ', ')
      .replaceAll(_questionKindSpaces, ' ')
      .replaceAll(_questionKindEdges, '');
  return shown.isEmpty ? null : clampCodePoints(shown, _questionKindShownMax);
}

/// Label for one data source of a grant or a grant suggestion, as the Kiingo
/// approvals page words it (`grantSourcesText`,
/// apps/agent-ui/src/pages/buzz/buzz-guest-question-kind.ts). A proposer (an
/// agent or the owner's MCP client) chooses these and the server checks only
/// their characters, so only a source in [guestOwnerOnlySources] (the only
/// ids a grant can ever cover) gets its label. Anything else, such as
/// "ross_approved_this", is someone's own text: quoted like a crafted
/// question kind (79, 2026-10-30). Mirrors desktop `grantSourceLabel`
/// (lib/copy.ts).
String grantSourceLabel(String source) {
  if (guestOwnerOnlySources.contains(source)) return dataSourceLabel(source);
  return '“${_inertOwnText(source) ?? '…'}”';
}

/// A grant's or a suggestion's data sources, joined: see [grantSourceLabel].
String grantSourcesLabel(Iterable<String> sources) =>
    sources.map(grantSourceLabel).join(', ');

/// A question kind as a badge: "Questions that need your calendar events".
String questionKindLabel(String? questionKind) {
  final words = questionKindWords(questionKind);
  return '${words[0].toUpperCase()}${words.substring(1)}';
}

/// "Always allow Jess for questions that need your calendar events?" from a
/// suggestion. Besides the grantee's name, the words come from fixed strings
/// and known codes; a crafted question kind or data source is quoted
/// ([questionKindWords], [grantSourceLabel]). A thread proposal's question
/// (agent text) is never part of it and goes on its own quoted line
/// (`suggestionThreadQuote`).
String suggestionQuestion(GuestSuggestion suggestion) {
  final who = suggestion.granteeDisplayName ?? 'this person';
  final kind = suggestion.questionKind;
  final sources = grantSourcesLabel(suggestion.dataSources);
  final topic = kind != null
      ? 'for ${questionKindWords(kind)}'
      : 'on ${sources.isNotEmpty ? sources : 'these questions'}';
  if (suggestion.proposedScope == GrantScope.always) {
    return 'Always allow $who $topic?';
  }
  if (suggestion.proposedScope == GrantScope.questionKind && kind != null) {
    return 'Allow $who $topic?';
  }
  return '${suggestionScopeLabel(suggestion)}: $who $topic?';
}

/// The scope words for a suggestion row, fixed strings only. A list has no
/// "this thread": a thread proposal points at the quoted question under it
/// when there is one (`thread_question`), else names a short root id.
String suggestionScopeLabel(GuestSuggestion suggestion) {
  if (suggestion.proposedScope != GrantScope.thread) {
    return scopeLabel(suggestion.proposedScope, days: suggestion.days);
  }
  if (suggestion.threadQuestion != null) return 'In the thread quoted below';
  final root = suggestion.threadRootEventId;
  return root != null
      ? 'In one thread (${root.length > 8 ? root.substring(0, 8) : root}…)'
      : 'In one thread';
}

/// The visible label on a thread proposal's quoted question.
const threadQuestionLabel = 'The question you were asked there:';

/// What a screen reader hears first on that line: it is quoted agent text.
const threadQuestionSpoken = 'Quoted agent text, not part of the grant.';

/// A thread proposal's question, quoted: “When is the offsite?”. It is
/// agent-written text that can carry outside content (79
/// LOW-GRANT-ROW-THREAD-QUESTION-AGENT-TEXT), so it is already inert
/// (`_inertLine`, guest_owner_records.dart) and is shown on its own
/// de-emphasized line, never in the grant sentence. Null for any other scope
/// or when none is on record.
String? suggestionThreadQuote(GuestSuggestion suggestion) {
  final question = suggestion.threadQuestion;
  if (suggestion.proposedScope != GrantScope.thread || question == null) {
    return null;
  }
  return '“$question”';
}

/// "Ada proposed this. Nothing is shared until you allow it." for an
/// agent-proposed grant; "You approved 3 similar requests." for a learned one.
String suggestionDetail(GuestSuggestion suggestion) {
  if (suggestion.agentProposed) {
    final who =
        suggestion.proposedByAgentName ??
        (suggestion.proposedVia == 'mcp_client'
            ? 'Your MCP client'
            : 'Your agent');
    return '$who proposed this. Nothing is shared until you allow it.';
  }
  final count = suggestion.approvalsCount;
  return 'You approved $count similar ${count == 1 ? 'request' : 'requests'}.';
}

/// Label for a shareable item's kind.
String shareableKindLabel(String kind) => switch (kind) {
  'status' => 'Status',
  'note' => 'Note or decision',
  'knowledge_item' => 'Knowledge item',
  _ => _humanize(kind),
};

const _suspensionReasons = {
  'two_high_flags_24h': 'Two high-risk requests within 24 hours',
};

/// Plain-language reason for a suspension code.
String suspensionReasonText(String reason) =>
    _suspensionReasons[reason] ?? reason;

/// Plain-language line for one org-admin alert.
String adminAlertText(GuestAdminAlert alert, String name) {
  final count = alert.count;
  if (alert.kind == 'requester_suspended') {
    return "$name can't ask anyone's agents anything until an admin restores "
        'access. Their requests were flagged high-risk'
        '${count != null && count > 0 ? ' $count times' : ''} in 24 hours.';
  }
  if (alert.kind == 'org_pattern') {
    if (alert.pattern == 'flagged_across_owners') {
      return "$name sent flagged requests to ${count ?? 'several'} different people's agents in 24 hours.";
    }
    if (alert.pattern == 'approval_requests_across_agents') {
      return "$name asked ${count ?? 'many'} different agents for things that need their owner's approval in 24 hours.";
    }
    return 'Unusual pattern of requests from $name.';
  }
  return "Something about agent guest access needs an admin's attention.";
}

/// Badge text for an org-admin alert.
String adminAlertBadge(GuestAdminAlert alert) =>
    alert.kind == 'requester_suspended' ? 'Suspended' : 'Unusual pattern';

/// "3 min ago", "5 h ago", "2 days ago" or "never".
String formatRelative(String? iso, {DateTime? now}) {
  final at = iso == null ? null : DateTime.tryParse(iso);
  if (at == null) return 'never';
  final minutes = (now ?? DateTime.now()).difference(at).inMinutes;
  if (minutes < 1) return 'just now';
  if (minutes < 60) return '$minutes min ago';
  final hours = (minutes / 60).round();
  if (hours < 48) return '$hours h ago';
  return '${(hours / 24).round()} days ago';
}

const _months = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/// "Oct 16, 14:05" in local time, or an empty string for a bad timestamp.
String formatShortDate(String? iso) {
  final at = iso == null ? null : DateTime.tryParse(iso)?.toLocal();
  if (at == null) return '';
  String two(int n) => n.toString().padLeft(2, '0');
  return '${_months[at.month - 1]} ${at.day}, ${two(at.hour)}:${two(at.minute)}';
}

/// "Oct 15, 2026" for a YYYY-MM-DD digest day.
String formatDigestDay(String date) {
  final at = DateTime.tryParse(date);
  if (at == null) return date;
  return '${_months[at.month - 1]} ${at.day}, ${at.year}';
}

/// One line under a grant: expiry, uses and last use.
String grantUsageLine(GuestGrant grant) {
  final expires = grant.expiresAt == null
      ? 'No expiry'
      : 'Expires ${formatShortDate(grant.expiresAt)}';
  final uses = grant.useCount == 1 ? 'time' : 'times';
  return '$expires · used ${grant.useCount} $uses · last used '
      '${formatRelative(grant.lastUsedAt)}';
}

/// One line for a classifier result on an access-log row, or `null`.
String? classifierLine(GuestClassifier classifier) {
  if (classifier.topScores.isNotEmpty) {
    final scores = classifier.topScores.entries
        .map(
          (entry) =>
              '${entry.key.replaceAll('_', ' ')} ${scorePercent(entry.value)}',
        )
        .join(' · ');
    final route = classifier.route;
    return 'Safety check${route != null ? ' $route' : ''}: $scores';
  }
  final route = classifier.route;
  if (route == null) return null;
  final severity = classifier.severity;
  return 'Safety check: $route${severity != null ? ' ($severity)' : ''}';
}
