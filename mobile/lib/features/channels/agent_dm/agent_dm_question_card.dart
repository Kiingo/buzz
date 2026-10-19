import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';

import '../../../shared/agent_dm/agent_dm_answers.dart';
import '../../../shared/agent_dm/agent_dm_markers.dart';
import '../../../shared/theme/buzz_icons.dart';
import '../../../shared/theme/theme.dart';

part 'agent_dm_question_card/question_block.dart';

/// What a question card shows and accepts.
enum AgentDmCardState {
  /// Accepts taps.
  open,

  /// This client's answer is being delivered; taps are paused.
  sending,

  /// Answered; no more taps.
  answered,

  /// Closed by the agent; no more taps.
  closed,
}

/// The buttons under an agent message that asks questions. The numbered
/// text above stays visible, so typing an answer works too.
///
/// A single single-select question sends on tap. Multi-select or several
/// questions collect choices and send them with Send.
class AgentDmQuestionCardView extends HookWidget {
  /// The card.
  final AgentDmQuestionCard card;

  /// Whether the card accepts taps, and what its status line says.
  final AgentDmCardState state;

  /// Sends a complete answer.
  final ValueChanged<AgentDmAnswer> onSubmit;

  const AgentDmQuestionCardView({
    super.key,
    required this.card,
    required this.state,
    required this.onSubmit,
  });

  @override
  Widget build(BuildContext context) {
    final selections = useState(const <String, AgentDmAnswerSelection>{});
    final enabled = state == AgentDmCardState.open;
    final answer = buildAgentDmAnswer(card, selections.value);
    final sendsOnTap = card.sendsOnTap;

    void submitOne(AgentDmQuestion question, AgentDmAnswerSelection selection) {
      if (!enabled) return;
      final single = buildAgentDmAnswer(card, {question.qid: selection});
      if (single != null) onSubmit(single);
    }

    void sendAll() {
      final complete = answer;
      if (enabled && complete != null) onSubmit(complete);
    }

    return Padding(
      padding: const EdgeInsets.only(top: Grid.half, left: Grid.xs),
      child: DecoratedBox(
        key: const ValueKey('agent-dm-question-card'),
        decoration: BoxDecoration(
          border: Border.all(color: context.colors.outlineVariant),
          borderRadius: BorderRadius.circular(Radii.lg),
        ),
        child: Padding(
          padding: const EdgeInsets.all(Grid.twelve),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              for (var index = 0; index < card.questions.length; index++)
                Padding(
                  padding: EdgeInsets.only(top: index == 0 ? 0 : Grid.twelve),
                  child: _QuestionBlock(
                    key: ValueKey(
                      'agent-dm-question-${card.questions[index].qid}',
                    ),
                    question: card.questions[index],
                    number: card.questions.length > 1 ? index + 1 : null,
                    selection:
                        selections.value[card.questions[index].qid] ??
                        AgentDmAnswerSelection.empty,
                    enabled: enabled,
                    sendsOnTap: sendsOnTap,
                    onChanged: (selection) => selections.value = {
                      ...selections.value,
                      card.questions[index].qid: selection,
                    },
                    onSubmit: (selection) =>
                        submitOne(card.questions[index], selection),
                  ),
                ),
              if (!sendsOnTap && enabled)
                Padding(
                  padding: const EdgeInsets.only(top: Grid.twelve),
                  child: Semantics(
                    container: true,
                    button: true,
                    enabled: answer != null,
                    label: 'Send answer',
                    excludeSemantics: true,
                    onTap: answer == null ? null : sendAll,
                    child: FilledButton(
                      key: const ValueKey('agent-dm-question-send'),
                      onPressed: answer == null ? null : sendAll,
                      child: const Text('Send'),
                    ),
                  ),
                ),
              if (state != AgentDmCardState.open)
                Padding(
                  padding: const EdgeInsets.only(top: Grid.xxs),
                  child: _CardStatus(state: state),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _CardStatus extends StatelessWidget {
  final AgentDmCardState state;

  const _CardStatus({required this.state});

  @override
  Widget build(BuildContext context) {
    final (label, icon) = switch (state) {
      AgentDmCardState.sending => ('Sending…', null),
      AgentDmCardState.answered => ('Answered', BuzzIcons.circleCheck),
      _ => ('Closed', BuzzIcons.circleX),
    };
    final color = context.colors.onSurfaceVariant;
    return Semantics(
      container: true,
      liveRegion: true,
      label: label,
      excludeSemantics: true,
      child: Row(
        key: const ValueKey('agent-dm-question-status'),
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[
            Icon(icon, size: 14, color: color),
            const SizedBox(width: Grid.half),
          ],
          Text(
            label,
            style: context.textTheme.labelSmall?.copyWith(color: color),
          ),
        ],
      ),
    );
  }
}
