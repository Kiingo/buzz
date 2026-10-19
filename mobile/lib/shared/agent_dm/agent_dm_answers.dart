import 'agent_dm_markers.dart';

/// What the person picked for one question: option labels, or typed "Other"
/// text. The two are exclusive.
class AgentDmAnswerSelection {
  /// Chosen option labels.
  final Set<String> labels;

  /// Typed "Other" text, or null when an option was chosen.
  final String? other;

  const AgentDmAnswerSelection({this.labels = const {}, this.other});

  /// Nothing chosen yet.
  static const empty = AgentDmAnswerSelection();

  /// Whether this selection answers [question].
  bool answers(AgentDmQuestion question) {
    final typed = other;
    if (typed != null) {
      return labels.isEmpty && question.allowOther && typed.trim().isNotEmpty;
    }
    if (labels.isEmpty) return false;
    if (!question.multi && labels.length != 1) return false;
    final known = {for (final option in question.options) option.label};
    return labels.every(known.contains);
  }
}

/// The message a question card sends: its content and `buzz-answer` tags.
class AgentDmAnswer {
  /// The answer text; the content alone answers the agent.
  final String content;

  /// `buzz-answer`, then one `buzz-answer-item` or `buzz-answer-other` per
  /// question, in question order.
  final List<List<String>> tags;

  const AgentDmAnswer({required this.content, required this.tags});
}

/// Builds the answer to [card] from [selections] keyed by question id, or
/// null when any question is unanswered or the selection is not valid for it.
///
/// One question: the chosen label, several labels joined by ", " for a
/// multi-select, or the typed text. Several questions: one `<n>. <answer>`
/// line per question in order, with line breaks in typed text folded to
/// spaces so each answer stays on its line.
AgentDmAnswer? buildAgentDmAnswer(
  AgentDmQuestionCard card,
  Map<String, AgentDmAnswerSelection> selections,
) {
  final answers = <String>[];
  final tags = <List<String>>[
    ['buzz-answer', card.askId],
  ];
  for (final question in card.questions) {
    final selection = selections[question.qid];
    if (selection == null || !selection.answers(question)) return null;
    final typed = selection.other;
    if (typed != null) {
      final text = typed.trim();
      answers.add(text);
      tags.add(['buzz-answer-other', question.qid, text]);
    } else {
      // Option order, not tap order, so the answer reads like the card.
      final labels = [
        for (final option in question.options)
          if (selection.labels.contains(option.label)) option.label,
      ];
      answers.add(labels.join(', '));
      tags.add(['buzz-answer-item', question.qid, ...labels]);
    }
  }
  final content = answers.length == 1
      ? answers.single
      : [
          for (var index = 0; index < answers.length; index++)
            '${index + 1}. ${answers[index].replaceAll(RegExp(r'\s+'), ' ')}',
        ].join('\n');
  return AgentDmAnswer(content: content, tags: tags);
}
