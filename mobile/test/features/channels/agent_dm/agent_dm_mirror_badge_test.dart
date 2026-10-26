import 'package:buzz/features/channels/agent_dm/agent_dm_relayed_frame.dart';
import 'package:buzz/features/channels/agent_dm/agent_dm_scope.dart';
import 'package:buzz/features/channels/agent_dm/agent_dm_timeline.dart';
import 'package:buzz/features/channels/channel.dart';
import 'package:buzz/features/channels/channel_identity_names_provider.dart';
import 'package:buzz/features/channels/timeline_message.dart';
import 'package:buzz/shared/identity_names/identity_names.dart';
import 'package:buzz/shared/relay/relay.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../helpers/widget_helpers.dart';

const _agent =
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const _me = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

final _dm = Channel(
  id: 'dm',
  name: 'dm',
  channelType: 'dm',
  visibility: 'private',
  description: '',
  createdBy: 'x',
  createdAt: DateTime(2025),
  memberCount: 2,
  isMember: true,
  participantPubkeys: const [_agent, _me],
);

NostrEvent _event(String id, List<List<String>> markers) => NostrEvent(
  id: id,
  pubkey: _agent,
  createdAt: 10,
  kind: EventKind.streamMessageV2,
  tags: [
    ['h', 'dm'],
    ...markers,
  ],
  content: 'Move my 3pm',
  sig: 'sig',
);

TimelineMessage _message(NostrEvent event) => TimelineMessage(
  id: event.id,
  pubkey: event.pubkey,
  createdAt: event.createdAt,
  content: event.content,
  tags: event.tags,
);

void main() {
  final requester = _event('requester', const [
    ['buzz-mirror', 'tasks', 't-1', '1700000000'],
    ['buzz-mirror-author', 'requester', _me, 'Ross'],
  ]);
  final own = _event('own', const [
    ['buzz-mirror', 'teams', 't-2', '1700000000'],
    ['buzz-mirror-author', 'agent', '', ''],
  ]);
  final timeline = AgentDmTimeline.build(
    events: [requester, own],
    isDm: true,
    memberPubkeys: const [_agent, _me],
    currentPubkey: _me,
    agentPubkeys: const {_agent},
  );

  Future<void> pumpMeta(WidgetTester tester, NostrEvent event) =>
      tester.pumpWidget(
        WidgetHelpers.testable(
          overrides: [
            channelIdentityNamesProvider('dm').overrideWithValue(
              const IdentityNameSources().scope(
                const [_agent, _me],
                fallbackNames: const {_agent: 'Juniper', _me: 'Ross'},
              ),
            ),
          ],
          child: AgentDmScope(
            timeline: timeline,
            channel: _dm,
            child: Builder(
              builder: (context) {
                final message = _message(event);
                return Column(
                  children: [
                    AgentDmScope.mirrorMetaFor(context, message) ??
                        const SizedBox.shrink(),
                    AgentDmRelayedFrame(
                      relayed: AgentDmScope.isRelayed(context, message),
                      child: Text(message.content),
                    ),
                  ],
                );
              },
            ),
          ),
        ),
      );

  testWidgets('a requester mirror always shows who relayed it', (tester) async {
    await pumpMeta(tester, requester);
    expect(find.text('via Kiingo Tasks'), findsOneWidget);
    expect(find.text('relayed by Juniper'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('agent-dm-mirror-relay-glyph')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('agent-dm-relayed-frame')),
      findsOneWidget,
    );
    // One screen-reader stop carries the whole relay line.
    expect(
      find.bySemanticsLabel('via Kiingo Tasks · relayed by Juniper'),
      findsOneWidget,
    );
  });

  testWidgets('the agent\'s own mirror keeps the plain badge', (tester) async {
    await pumpMeta(tester, own);
    expect(find.text('via Teams'), findsOneWidget);
    expect(find.textContaining('relayed by'), findsNothing);
    expect(
      find.byKey(const ValueKey('agent-dm-mirror-relay-glyph')),
      findsNothing,
    );
    expect(find.byKey(const ValueKey('agent-dm-relayed-frame')), findsNothing);
  });

  testWidgets('copy text reads the relayed form', (tester) async {
    await pumpMeta(tester, requester);
    final context = tester.element(find.text('Move my 3pm'));
    final display = AgentDmScope.mirrorDisplayOf(
      context,
      _message(requester),
      (pubkey) => pubkey == _me ? 'Ross' : 'Juniper',
    );
    expect(
      display?.plainText('Move my 3pm'),
      'Ross (via Kiingo Tasks, relayed by Juniper): Move my 3pm',
    );
  });
}
