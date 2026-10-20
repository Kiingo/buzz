import 'package:buzz/features/channels/agent_dm/agent_dm_message_footer.dart';
import 'package:buzz/features/channels/agent_dm/agent_dm_question_card.dart';
import 'package:buzz/features/channels/agent_dm/agent_dm_sent_provider.dart';
import 'package:buzz/features/channels/agent_dm/agent_dm_timeline.dart';
import 'package:buzz/shared/agent_dm/agent_dm_answers.dart';
import 'package:buzz/shared/agent_dm/agent_dm_markers.dart';
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../helpers/widget_helpers.dart';

AgentDmQuestionCard _card(List<List<String>> body) => readAgentDmQuestionCard([
  const ['buzz-question', 'ask-1'],
  ...body,
])!;

final _single = _card(const [
  ['buzz-question-item', 'q1', 'Ship it?', '', '0', '1'],
  ['buzz-question-option', 'q1', 'Yes', ''],
  ['buzz-question-option', 'q1', 'No', 'Not this week'],
]);

final _several = _card(const [
  ['buzz-question-item', 'q1', 'Ship it?', 'Release', '0', '0'],
  ['buzz-question-option', 'q1', 'Yes', ''],
  ['buzz-question-option', 'q1', 'No', ''],
  ['buzz-question-item', 'q2', 'Which days?', '', '1', '0'],
  ['buzz-question-option', 'q2', 'Mon', ''],
  ['buzz-question-option', 'q2', 'Tue', ''],
]);

Future<List<AgentDmAnswer>> _pump(
  WidgetTester tester,
  AgentDmQuestionCard card, {
  AgentDmCardState state = AgentDmCardState.open,
}) async {
  final sent = <AgentDmAnswer>[];
  await tester.pumpWidget(
    WidgetHelpers.testable(
      child: SingleChildScrollView(
        child: AgentDmQuestionCardView(
          card: card,
          state: state,
          onSubmit: sent.add,
        ),
      ),
    ),
  );
  return sent;
}

Finder _option(String qid, String label) =>
    find.byKey(ValueKey('agent-dm-option-$qid-$label'));

void main() {
  testWidgets('a single single-select question sends on tap', (tester) async {
    final sent = await _pump(tester, _single);
    expect(find.byKey(const ValueKey('agent-dm-question-send')), findsNothing);

    await tester.tap(_option('q1', 'No'));
    await tester.pump();

    expect(sent.single.content, 'No');
    expect(sent.single.tags, [
      ['buzz-answer', 'ask-1'],
      ['buzz-answer-item', 'q1', 'No'],
    ]);
  });

  testWidgets('a typed Other answer sends from its own button', (tester) async {
    final sent = await _pump(tester, _single);
    await tester.enterText(
      find.byKey(const ValueKey('agent-dm-other-q1')),
      'Next month',
    );
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('agent-dm-other-send-q1')));
    await tester.pump();
    expect(sent.single.content, 'Next month');
    expect(sent.single.tags.last, ['buzz-answer-other', 'q1', 'Next month']);
  });

  testWidgets('several questions collect choices and send with Send', (
    tester,
  ) async {
    final sent = await _pump(tester, _several);
    final send = find.byKey(const ValueKey('agent-dm-question-send'));
    expect(tester.widget<FilledButton>(send).onPressed, isNull);

    await tester.tap(_option('q1', 'Yes'));
    await tester.tap(_option('q2', 'Tue'));
    await tester.tap(_option('q2', 'Mon'));
    await tester.pump();
    expect(sent, isEmpty, reason: 'nothing sends before Send');
    expect(tester.widget<FilledButton>(send).onPressed, isNotNull);

    await tester.tap(send);
    await tester.pump();
    expect(sent.single.content, '1. Yes\n2. Mon, Tue');
  });

  testWidgets('a closed card shows Closed and accepts no taps', (tester) async {
    final sent = await _pump(tester, _single, state: AgentDmCardState.closed);
    expect(find.text('Closed'), findsOneWidget);
    expect(find.byKey(const ValueKey('agent-dm-other-q1')), findsNothing);
    await tester.tap(_option('q1', 'Yes'), warnIfMissed: false);
    await tester.pump();
    expect(sent, isEmpty);
  });

  testWidgets('an answered card shows Answered and accepts no taps', (
    tester,
  ) async {
    final sent = await _pump(
      tester,
      _several,
      state: AgentDmCardState.answered,
    );
    expect(find.text('Answered'), findsOneWidget);
    expect(find.byKey(const ValueKey('agent-dm-question-send')), findsNothing);
    await tester.tap(_option('q1', 'Yes'), warnIfMissed: false);
    await tester.pump();
    expect(sent, isEmpty);
  });

  testWidgets('each option is one labelled, tappable semantics node', (
    tester,
  ) async {
    final handle = tester.ensureSemantics();
    await _pump(tester, _single);
    expect(
      find.bySemanticsLabel('No'),
      findsOneWidget,
      reason: 'one owner per actionable label',
    );
    final node = tester.getSemantics(find.bySemanticsLabel('No'));
    final data = node.getSemanticsData();
    expect(data.hasAction(SemanticsAction.tap), isTrue);
    expect(data.hint, 'Not this week');
    handle.dispose();
  });

  group('agentDmCardState', () {
    test('answered wins over closed and over a local send', () {
      expect(
        agentDmCardState(AgentDmQuestionStatus.closed, AgentDmSendStatus.sent),
        AgentDmCardState.answered,
      );
      expect(
        agentDmCardState(AgentDmQuestionStatus.answered, null),
        AgentDmCardState.answered,
      );
    });

    test('closed beats an in-flight send; sending pauses an open card', () {
      expect(
        agentDmCardState(
          AgentDmQuestionStatus.closed,
          AgentDmSendStatus.sending,
        ),
        AgentDmCardState.closed,
      );
      expect(
        agentDmCardState(AgentDmQuestionStatus.open, AgentDmSendStatus.sending),
        AgentDmCardState.sending,
      );
      expect(
        agentDmCardState(AgentDmQuestionStatus.open, null),
        AgentDmCardState.open,
      );
    });
  });
}
