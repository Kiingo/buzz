import 'package:buzz/shared/agent_dm/agent_dm_quiet.dart';
import 'package:buzz/shared/relay/relay.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  const agent =
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const person =
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const members = [agent, person];

  NostrEvent event(
    List<List<String>> markers, {
    int kind = EventKind.streamMessageV2,
    String signer = agent,
  }) => NostrEvent(
    id: 'e',
    pubkey: signer,
    createdAt: 1,
    kind: kind,
    tags: [
      ['h', 'dm'],
      ...markers,
    ],
    content: 'text',
    sig: 'sig',
  );

  const mirror = [
    ['buzz-mirror', 'email', 'm-1', '1700000000'],
    ['buzz-mirror-author', 'agent', '', ''],
  ];

  test('every quiet marker on kind 40002 from a DM member is quiet', () {
    for (final markers in const [
      mirror,
      [
        ['buzz-session', 'new', ''],
      ],
      [
        ['buzz-sessions', ''],
      ],
      [
        ['buzz-question-state', 'ask-1', 'closed'],
      ],
    ]) {
      expect(
        isQuietAgentDmEvent(event(markers), isDm: true, memberPubkeys: members),
        isTrue,
        reason: '$markers',
      );
    }
  });

  test('a marker that was addressed with a p tag is still quiet', () {
    expect(
      isQuietAgentDmEvent(
        event([
          ...mirror,
          ['p', person],
        ]),
        isDm: true,
        memberPubkeys: members,
      ),
      isTrue,
    );
  });

  test('not quiet on the wrong kind, outside a DM or from a non-member', () {
    expect(
      isQuietAgentDmEvent(
        event(mirror, kind: EventKind.streamMessage),
        isDm: true,
        memberPubkeys: members,
      ),
      isFalse,
    );
    expect(
      isQuietAgentDmEvent(event(mirror), isDm: false, memberPubkeys: members),
      isFalse,
    );
    expect(
      isQuietAgentDmEvent(
        event(mirror),
        isDm: true,
        memberPubkeys: const [person],
      ),
      isFalse,
    );
  });

  test('a malformed marker is an ordinary message', () {
    expect(
      isQuietAgentDmEvent(
        event(const [
          ['buzz-mirror', 'email', 'm-1'],
        ]),
        isDm: true,
        memberPubkeys: members,
      ),
      isFalse,
    );
    expect(
      isQuietAgentDmEvent(
        event(const [
          ['buzz-question', 'ask-1'],
        ]),
        isDm: true,
        memberPubkeys: members,
      ),
      isFalse,
      reason: 'a question card is a normal, notifying reply',
    );
  });
}
