import 'package:buzz/shared/agent_dm/agent_dm_answers.dart';
import 'package:buzz/shared/agent_dm/agent_dm_markers.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  AgentDmQuestionCard card(List<List<String>> body) => readAgentDmQuestionCard([
    const ['buzz-question', 'ask-1'],
    ...body,
  ])!;

  final single = card(const [
    ['buzz-question-item', 'q1', 'Ship it?', '', '0', '1'],
    ['buzz-question-option', 'q1', 'Yes', ''],
    ['buzz-question-option', 'q1', 'No', ''],
  ]);
  final multi = card(const [
    ['buzz-question-item', 'q1', 'Which days?', '', '1', '0'],
    ['buzz-question-option', 'q1', 'Mon', ''],
    ['buzz-question-option', 'q1', 'Tue', ''],
    ['buzz-question-option', 'q1', 'Wed', ''],
  ]);
  final several = card(const [
    ['buzz-question-item', 'q1', 'Ship it?', '', '0', '0'],
    ['buzz-question-option', 'q1', 'Yes', ''],
    ['buzz-question-option', 'q1', 'No', ''],
    ['buzz-question-item', 'q2', 'Who?', '', '0', '1'],
    ['buzz-question-option', 'q2', 'Me', ''],
  ]);

  test('one question answers with the chosen label', () {
    final answer = buildAgentDmAnswer(single, {
      'q1': const AgentDmAnswerSelection(labels: {'Yes'}),
    })!;
    expect(answer.content, 'Yes');
    expect(answer.tags, [
      ['buzz-answer', 'ask-1'],
      ['buzz-answer-item', 'q1', 'Yes'],
    ]);
  });

  test('a multi-select joins labels with ", " in option order', () {
    final answer = buildAgentDmAnswer(multi, {
      'q1': const AgentDmAnswerSelection(labels: {'Wed', 'Mon'}),
    })!;
    expect(answer.content, 'Mon, Wed');
    expect(answer.tags.last, ['buzz-answer-item', 'q1', 'Mon', 'Wed']);
  });

  test('typed Other text is the whole answer', () {
    final answer = buildAgentDmAnswer(single, {
      'q1': const AgentDmAnswerSelection(other: '  Next week\nplease '),
    })!;
    expect(answer.content, 'Next week\nplease');
    expect(answer.tags.last, ['buzz-answer-other', 'q1', 'Next week\nplease']);
  });

  test('several questions answer one numbered line each, in order', () {
    final answer = buildAgentDmAnswer(several, {
      'q2': const AgentDmAnswerSelection(other: 'Sam\nand Alex'),
      'q1': const AgentDmAnswerSelection(labels: {'No'}),
    })!;
    expect(answer.content, '1. No\n2. Sam and Alex');
    expect(answer.tags, [
      ['buzz-answer', 'ask-1'],
      ['buzz-answer-item', 'q1', 'No'],
      ['buzz-answer-other', 'q2', 'Sam\nand Alex'],
    ]);
  });

  test('incomplete or invalid selections build nothing', () {
    expect(
      buildAgentDmAnswer(several, {
        'q1': const AgentDmAnswerSelection(labels: {'Yes'}),
      }),
      isNull,
    );
    expect(
      buildAgentDmAnswer(single, {
        'q1': const AgentDmAnswerSelection(labels: {'Yes', 'No'}),
      }),
      isNull,
      reason: 'single-select takes one label',
    );
    expect(
      buildAgentDmAnswer(single, {
        'q1': const AgentDmAnswerSelection(labels: {'Maybe'}),
      }),
      isNull,
      reason: 'unknown label',
    );
    expect(
      buildAgentDmAnswer(multi, {
        'q1': const AgentDmAnswerSelection(other: 'Thu'),
      }),
      isNull,
      reason: 'Other is not allowed here',
    );
    expect(
      buildAgentDmAnswer(single, {
        'q1': const AgentDmAnswerSelection(other: '   '),
      }),
      isNull,
    );
  });
}
