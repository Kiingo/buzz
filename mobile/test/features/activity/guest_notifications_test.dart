import 'dart:convert';
import 'dart:typed_data';

import 'package:buzz/features/activity/feed_item.dart';
import 'package:buzz/features/activity/guest_notifications.dart';
import 'package:buzz/shared/relay/relay.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nostr/nostr.dart' as nostr;
import 'package:pointycastle/digests/sha256.dart';

String _sha256Hex(String input) {
  final digest = SHA256Digest().process(Uint8List.fromList(utf8.encode(input)));
  return digest.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
}

NostrEvent _event({
  required String pubkey,
  required int kind,
  required List<List<String>> tags,
  String id = '',
  int createdAt = 100,
  String content = '',
}) => NostrEvent(
  id: id.isEmpty ? '${kind}_$createdAt' : id,
  pubkey: pubkey,
  createdAt: createdAt,
  kind: kind,
  tags: tags,
  content: content,
  sig: '',
);

void main() {
  final owner = nostr.Keys.generate();
  final agent = nostr.Keys.generate();
  final stranger = nostr.Keys.generate();
  final ownerPk = owner.public.toLowerCase();

  NostrEvent profile(String agentPubkey, nostr.Keys signer) {
    final sig = nostr.Schnorr.sign(
      secretKey: signer.secret,
      message: _sha256Hex('nostr:agent-auth:$agentPubkey:'),
    );
    return _event(
      pubkey: agentPubkey,
      kind: 0,
      tags: [
        ['auth', signer.public, '', sig],
      ],
    );
  }

  NostrEvent requested(String author, String approvalId, {String? p}) => _event(
    pubkey: author,
    kind: guestApprovalRequestedKind,
    id: 'req-$approvalId-$author',
    tags: [
      ['p', p ?? ownerPk],
      ['buzz-guest-approval', approvalId],
      ['agent', author],
    ],
    content: 'Jess asked Atlas something that needs your approval.',
  );

  test('trusts only agents whose NIP-OA owner is this user', () {
    final trusted = trustedGuestNotifiers(
      profiles: [
        profile(agent.public, owner),
        profile(stranger.public, stranger),
      ],
      ownerPubkey: ownerPk,
    );
    expect(trusted, {agent.public.toLowerCase()});
  });

  test('shows unresolved requests and alerts from trusted agents only', () {
    final trusted = {agent.public.toLowerCase()};
    final events = [
      requested(agent.public, 'open'),
      requested(agent.public, 'done'),
      _event(
        pubkey: agent.public,
        kind: guestApprovalResolvedKind,
        tags: [
          ['p', ownerPk],
          ['buzz-guest-approval', 'done'],
          ['agent', agent.public],
          ['status', 'approved'],
        ],
      ),
      _event(
        pubkey: agent.public,
        kind: guestAlertKind,
        tags: [
          ['p', ownerPk],
          ['buzz-guest-alert', 'a1'],
          ['severity', 'high'],
          ['agent', agent.public],
        ],
      ),
      requested(stranger.public, 'spoof'),
      requested(agent.public, 'elsewhere', p: 'b' * 64),
    ];

    final visible = visibleGuestNotifications(
      events: events,
      trustedAuthors: trusted,
      ownerPubkey: ownerPk,
    );
    expect(visible.map((event) => event.kind), [
      guestApprovalRequestedKind,
      guestAlertKind,
    ]);
    expect(visible.first.id, 'req-open-${agent.public}');
  });

  test('feed items label guest approvals and alerts', () {
    FeedItem item(int kind) => FeedItem.fromJson({
      'id': 'x',
      'kind': kind,
      'pubkey': agent.public,
      'content': 'Jess asked Atlas something that needs your approval.',
      'created_at': 1,
      'channel_id': null,
      'channel_name': '',
      'tags': <List<String>>[],
      'category': 'needs_action',
    });
    expect(item(46040).headline, 'Approval requested');
    expect(item(46042).headline, 'Agent alert');
  });
}
