import 'package:buzz/features/activity/quiet_feed_events.dart';
import 'package:buzz/features/channels/channel.dart';
import 'package:buzz/shared/relay/relay.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  const agent =
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const me = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  Channel channel(String id, String type) => Channel(
    id: id,
    name: id,
    channelType: type,
    visibility: 'private',
    description: '',
    createdBy: 'x',
    createdAt: DateTime(2025),
    memberCount: 2,
    isMember: true,
    participantPubkeys: const [agent, me],
  );

  NostrEvent divider(String channelId) => NostrEvent(
    id: 'd-$channelId',
    pubkey: agent,
    createdAt: 1,
    kind: EventKind.streamMessageV2,
    tags: [
      ['h', channelId],
      ['buzz-session', 'new', ''],
    ],
    content: 'New session.',
    sig: '',
  );

  test('quiet only in a known DM', () {
    final isQuiet = quietAgentDmFeedFilter([
      channel('dm', 'dm'),
      channel('general', 'stream'),
    ]);
    expect(isQuiet(divider('dm')), isTrue);
    expect(isQuiet(divider('general')), isFalse);
    expect(isQuiet(divider('unknown')), isFalse);
  });
}
