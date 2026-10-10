import '../../shared/crypto/nip_oa.dart';
import '../../shared/relay/relay.dart';

/// Agent guest access owner notifications (relay kinds 46040–46042):
/// approval requested, approval resolved, and alert. Each is addressed to the
/// owner by a single `p` tag and signed by one of the owner's own agents.
const guestApprovalRequestedKind = 46040;
const guestApprovalResolvedKind = 46041;
const guestAlertKind = 46042;
const guestNotificationKinds = [
  guestApprovalRequestedKind,
  guestApprovalResolvedKind,
  guestAlertKind,
];

String? _tag(NostrEvent event, String name) {
  for (final tag in event.tags) {
    if (tag.length > 1 && tag[0] == name) return tag[1];
  }
  return null;
}

/// Authors whose newest signed kind:0 carries a NIP-OA `auth` tag that
/// verifies to [ownerPubkey], i.e. the owner's own agents.
Set<String> trustedGuestNotifiers({
  required Iterable<NostrEvent> profiles,
  required String ownerPubkey,
}) {
  final owner = ownerPubkey.toLowerCase();
  final newest = <String, NostrEvent>{};
  for (final profile in profiles) {
    if (profile.kind != 0) continue;
    final author = profile.pubkey.toLowerCase();
    final current = newest[author];
    if (current == null || profile.createdAt > current.createdAt) {
      newest[author] = profile;
    }
  }
  return {
    for (final entry in newest.entries)
      if (verifiedOaOwnerPubkey(entry.value.tags, entry.key)?.toLowerCase() ==
          owner)
        entry.key,
  };
}

/// The guest notifications to show in Needs Action: approval requests that
/// have not been resolved, and alerts, from trusted authors addressed to the
/// owner by exactly one `p` tag.
List<NostrEvent> visibleGuestNotifications({
  required Iterable<NostrEvent> events,
  required Set<String> trustedAuthors,
  required String ownerPubkey,
}) {
  final owner = ownerPubkey.toLowerCase();
  bool addressedOnlyToOwner(NostrEvent event) {
    final pTags = [
      for (final tag in event.tags)
        if (tag.length > 1 && tag[0] == 'p') tag[1].toLowerCase(),
    ];
    return pTags.length == 1 && pTags.single == owner;
  }

  final trusted = [
    for (final event in events)
      if (guestNotificationKinds.contains(event.kind) &&
          trustedAuthors.contains(event.pubkey.toLowerCase()) &&
          addressedOnlyToOwner(event))
        event,
  ];
  final resolved = <String>{};
  for (final event in trusted) {
    final approvalId = _tag(event, 'buzz-guest-approval');
    if (event.kind == guestApprovalResolvedKind && approvalId != null) {
      resolved.add(approvalId);
    }
  }
  return [
    for (final event in trusted)
      if (event.kind == guestAlertKind ||
          (event.kind == guestApprovalRequestedKind &&
              !resolved.contains(_tag(event, 'buzz-guest-approval'))))
        event,
  ];
}
