import 'package:buzz/features/channels/agent_dm/agent_dm_sessions_button.dart';
import 'package:buzz/features/channels/channel.dart';
import 'package:buzz/shared/hosted_agents/session_controls.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

const _agent =
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const _me = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const _person =
    'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

Channel _dm(List<String> participants) => Channel(
  id: 'dm',
  name: 'dm',
  channelType: 'dm',
  visibility: 'private',
  description: '',
  createdBy: 'x',
  createdAt: DateTime(2025),
  memberCount: participants.length,
  isMember: true,
  participantPubkeys: participants,
);

Future<List<String>> _pump(
  WidgetTester tester, {
  required Channel channel,
  required SessionControlsLookup? lookup,
}) async {
  final asked = <String>[];
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        sessionControlsLookupProvider.overrideWithValue(
          lookup == null
              ? null
              : (agent) {
                  asked.add(agent);
                  return lookup(agent);
                },
        ),
      ],
      child: MaterialApp(
        home: Consumer(
          builder: (context, ref, _) => Text(
            watchAgentDmSessionsAgent(
                  ref,
                  channel: channel,
                  currentPubkey: _me,
                  agentPubkeys: const {_agent},
                ) ??
                'no picker',
          ),
        ),
      ),
    ),
  );
  await tester.pump();
  await tester.pump();
  return asked;
}

void main() {
  testWidgets('offers the picker when session controls are on', (tester) async {
    final asked = await _pump(
      tester,
      channel: _dm(const [_me, _agent]),
      lookup: (_) async => true,
    );
    expect(find.text(_agent), findsOneWidget);
    expect(asked, [_agent]);
  });

  testWidgets('hides the picker when session controls are off', (tester) async {
    await _pump(
      tester,
      channel: _dm(const [_me, _agent]),
      lookup: (_) async => false,
    );
    expect(find.text('no picker'), findsOneWidget);
  });

  testWidgets('hides the picker when the check fails', (tester) async {
    await _pump(
      tester,
      channel: _dm(const [_me, _agent]),
      lookup: (_) async => throw StateError('offline'),
    );
    expect(find.text('no picker'), findsOneWidget);
  });

  testWidgets('never asks outside a 1:1 DM with an agent', (tester) async {
    final asked = await _pump(
      tester,
      channel: _dm(const [_me, _person]),
      lookup: (_) async => true,
    );
    expect(find.text('no picker'), findsOneWidget);
    expect(asked, isEmpty, reason: 'asked lazily, only for an agent DM');
  });
}
