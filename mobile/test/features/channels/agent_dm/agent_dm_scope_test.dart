import 'package:buzz/features/channels/agent_dm/agent_dm_scope.dart';
import 'package:buzz/features/channels/agent_dm/agent_dm_timeline.dart';
import 'package:buzz/features/channels/channel.dart';
import 'package:buzz/features/channels/timeline_message.dart';
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

NostrEvent _event(String id, List<List<String>> markers, String content) =>
    NostrEvent(
      id: id,
      pubkey: _agent,
      createdAt: 10,
      kind: EventKind.streamMessageV2,
      tags: [
        ['h', 'dm'],
        ...markers,
      ],
      content: content,
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
  final divider = _event('divider', const [
    ['buzz-session', 'new', ''],
  ], 'Started a fresh session.');
  final listing = _event('listing', const [
    ['buzz-sessions', ''],
    ['buzz-session-item', 's-1', 'current', '1', '2', 'Planning', '1', '4'],
  ], '1. Planning');
  final plain = _event('plain', const [], 'Just text');
  final timeline = AgentDmTimeline.build(
    events: [divider, listing, plain],
    isDm: true,
    memberPubkeys: const [_agent, _me],
    currentPubkey: _me,
    agentPubkeys: const {_agent},
  );

  Future<void> pumpRow(WidgetTester tester, NostrEvent event) =>
      tester.pumpWidget(
        WidgetHelpers.testable(
          child: AgentDmScope(
            timeline: timeline,
            channel: _dm,
            child: Builder(
              builder: (context) =>
                  AgentDmScope.rowFor(context, _message(event)) ??
                  const Text('plain row'),
            ),
          ),
        ),
      );

  testWidgets('a divider renders its label and caption as one stop', (
    tester,
  ) async {
    final handle = tester.ensureSemantics();
    await pumpRow(tester, divider);
    expect(find.text('New session'), findsOneWidget);
    expect(find.text('Started a fresh session.'), findsOneWidget);
    expect(
      find.bySemanticsLabel('New session. Started a fresh session.'),
      findsOneWidget,
    );
    handle.dispose();
  });

  testWidgets('a listing renders a compact list', (tester) async {
    await pumpRow(tester, listing);
    expect(find.text('Sessions'), findsOneWidget);
    expect(find.text('Planning'), findsOneWidget);
  });

  testWidgets('other messages keep their ordinary row', (tester) async {
    await pumpRow(tester, plain);
    expect(find.text('plain row'), findsOneWidget);
  });

  testWidgets('without a scope nothing is replaced', (tester) async {
    await tester.pumpWidget(
      WidgetHelpers.testable(
        child: Builder(
          builder: (context) =>
              AgentDmScope.rowFor(context, _message(divider)) ??
              const Text('plain row'),
        ),
      ),
    );
    expect(find.text('plain row'), findsOneWidget);
  });
}
