import 'package:buzz/features/channels/agent_dm/agent_dm_call_card_row.dart';
import 'package:buzz/shared/agent_dm/agent_dm_markers.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

const _call = '11111111-1111-4111-8111-111111111111';

List<List<String>> _tags({List<String>? call, String surface = 'voice'}) => [
  ['h', '22222222-2222-4222-8222-222222222222'],
  ['buzz-mirror', surface, _call, '1792470000'],
  ['buzz-mirror-author', 'agent', '', ''],
  ?call,
];

const _content =
    'Call · 3 min\n\nWe agreed to move the review.\n\nTranscript\nYou: hi\nAgent: hello';

void main() {
  group('readAgentDmCall', () {
    test('reads a voice mirror with one buzz-call tag', () {
      final call = readAgentDmCall(
        _tags(call: ['buzz-call', 'outbound', '170', 'tasks_ios']),
      )!;
      expect(call.direction, AgentDmCallDirection.outbound);
      expect(call.durationS, 170);
      expect(call.surface, 'tasks_ios');
      expect(call.title, 'Call · 3 min');
    });

    test('is null without the tag, on another surface, or malformed', () {
      expect(readAgentDmCall(_tags()), isNull);
      expect(
        readAgentDmCall(
          _tags(call: ['buzz-call', 'inbound', '60', 'web'], surface: 'email'),
        ),
        isNull,
      );
      expect(
        readAgentDmCall(_tags(call: ['buzz-call', 'sideways', '60', 'web'])),
        isNull,
      );
      expect(
        readAgentDmCall(_tags(call: ['buzz-call', 'inbound', '-1', 'web'])),
        isNull,
      );
    });

    test('a short call still reads one minute', () {
      expect(
        const AgentDmCall(
          direction: AgentDmCallDirection.inbound,
          durationS: 10,
          surface: 'web',
        ).title,
        'Call · 1 min',
      );
    });
  });

  test('a voice reply mirror is badged via voice call', () {
    expect(readAgentDmMirror(_tags())!.badgeLabel, 'via voice call');
  });

  test('splits summary from transcript', () {
    final parts = splitAgentDmCallContent(_content);
    expect(parts.summary, 'We agreed to move the review.');
    expect(parts.transcript, 'You: hi\nAgent: hello');
    expect(
      splitAgentDmCallContent('Call · 1 min\n\nOnly a summary').transcript,
      isNull,
    );
  });

  testWidgets('the card is collapsed until Show transcript', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: AgentDmCallCardRow(
            call: AgentDmCall(
              direction: AgentDmCallDirection.inbound,
              durationS: 180,
              surface: 'web',
            ),
            content: _content,
          ),
        ),
      ),
    );
    expect(find.text('Call · 3 min'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('agent-dm-call-transcript')),
      findsNothing,
    );
    await tester.tap(find.text('Show transcript'));
    await tester.pump();
    expect(
      find.byKey(const ValueKey('agent-dm-call-transcript')),
      findsOneWidget,
    );
    expect(find.text('Hide transcript'), findsOneWidget);
  });
}
