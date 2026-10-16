/// Plain-language wording for the owner's guest-access settings, matching
/// desktop (desktop/src/features/guest-access `lib/copy.ts`,
/// `lib/adminCopy.ts` and the Access dialog tabs). The route returns stable
/// machine codes; owners see sentences. Unknown codes fall back to a
/// humanized code so a new server value is still readable.
library;

import 'guest_approval.dart';
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

/// "Always allow Jess on pipeline?" for a learned-grant suggestion.
String suggestionQuestion(GuestSuggestion suggestion) {
  final who = suggestion.granteeDisplayName ?? 'this person';
  final kind = suggestion.questionKind;
  final sources = suggestion.dataSources.map(dataSourceLabel).join(', ');
  final topic = kind != null
      ? kind.replaceAll('_', ' ')
      : (sources.isNotEmpty ? sources : 'these questions');
  final scope = suggestion.proposedScope == GrantScope.always
      ? 'Always allow'
      : '${scopeLabel(suggestion.proposedScope)}:';
  return '$scope $who on $topic?';
}

/// "You approved 3 similar requests."
String suggestionDetail(GuestSuggestion suggestion) {
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
