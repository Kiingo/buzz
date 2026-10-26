import 'package:buzz/features/channels/agent_dm/agent_dm_scope.dart';
import 'package:buzz/features/channels/agent_dm/agent_dm_thread_scope.dart';
import 'package:buzz/features/channels/channel.dart';
import 'package:buzz/features/channels/channel_management_provider.dart';
import 'package:buzz/features/channels/timeline_message.dart';
import 'package:buzz/shared/mentions/agent_identity_provider.dart';
import 'package:buzz/shared/relay/relay.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../helpers/widget_helpers.dart';

const _agent =
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const _alex =
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

Channel _channel(String type) => Channel(
  id: 'dm',
  name: 'dm',
  channelType: type,
  visibility: 'private',
  description: '',
  createdBy: 'x',
  createdAt: DateTime(2025),
  memberCount: 2,
  isMember: true,
  participantPubkeys: const [_agent, _alex],
);

final _mirror = NostrEvent(
  id: 'mirror',
  pubkey: _agent,
  createdAt: 10,
  kind: EventKind.streamMessageV2,
  tags: const [
    ['h', 'dm'],
    ['buzz-mirror', 'tasks', 't-1', '1700000000'],
    ['buzz-mirror-author', 'requester', _alex, ''],
  ],
  content: 'Move my 3pm',
  sig: 'sig',
);

TimelineMessage get _message => TimelineMessage(
  id: _mirror.id,
  pubkey: _mirror.pubkey,
  createdAt: _mirror.createdAt,
  content: _mirror.content,
  tags: _mirror.tags,
);

void main() {
  Future<void> pump(WidgetTester tester, Channel? channel) => tester.pumpWidget(
    WidgetHelpers.testable(
      overrides: [
        channelMembersProvider('dm').overrideWith(
          (ref) async => [
            ChannelMember(
              pubkey: _agent,
              role: 'bot',
              joinedAt: DateTime(2026),
            ),
            ChannelMember(
              pubkey: _alex,
              role: 'member',
              joinedAt: DateTime(2026),
            ),
          ],
        ),
        agentProfileOwnerProvider(_agent).overrideWith((ref) async => null),
      ],
      child: AgentDmThreadScope(
        channel: channel,
        events: [_mirror],
        currentPubkey: _alex,
        agentPubkeys: const {_agent},
        child: Builder(
          builder: (context) => Text(
            'relayed=${AgentDmScope.isRelayed(context, _message)} '
            'author=${AgentDmScope.authorOf(context, _message) == _alex}',
          ),
        ),
      ),
    ),
  );

  testWidgets('a pushed DM thread route keeps the mirror rule', (tester) async {
    await pump(tester, _channel('dm'));
    await tester.pump();
    expect(find.text('relayed=true author=true'), findsOneWidget);
  });

  testWidgets('outside a DM, or before the channel loads, nothing changes', (
    tester,
  ) async {
    await pump(tester, null);
    expect(find.text('relayed=false author=false'), findsOneWidget);
    await pump(tester, _channel('stream'));
    expect(find.text('relayed=false author=false'), findsOneWidget);
  });

  test('only a head with a mirror tag needs its event fetched', () {
    expect(agentDmHeadNeedsEvent(_mirror.tags), isTrue);
    expect(
      agentDmHeadNeedsEvent(const [
        ['h', 'dm'],
        ['buzz-mirror-author', 'requester', _alex, ''],
      ]),
      isFalse,
    );
    expect(agentDmHeadNeedsEvent(const [[]]), isFalse);
  });
}
