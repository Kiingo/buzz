part of '../agent_dm_question_card.dart';

/// Turns a question's current selection into its next one.
typedef _SelectionUpdate =
    AgentDmAnswerSelection Function(AgentDmAnswerSelection current);

/// One question: its header, text, option buttons and optional "Other"
/// field. Options and typed text are exclusive.
class _QuestionBlock extends HookWidget {
  final AgentDmQuestion question;
  final int? number;
  final AgentDmAnswerSelection selection;
  final bool enabled;
  final bool sendsOnTap;
  final ValueChanged<_SelectionUpdate> onChanged;
  final ValueChanged<AgentDmAnswerSelection> onSubmit;

  const _QuestionBlock({
    super.key,
    required this.question,
    required this.number,
    required this.selection,
    required this.enabled,
    required this.sendsOnTap,
    required this.onChanged,
    required this.onSubmit,
  });

  @override
  Widget build(BuildContext context) {
    final other = useTextEditingController();
    final otherText = useValueListenable(other).text;
    final questionText = number == null
        ? question.text
        : '$number. ${question.text}';

    void tapOption(String label) {
      if (!enabled) return;
      if (sendsOnTap) {
        onSubmit(AgentDmAnswerSelection(labels: {label}));
        return;
      }
      other.clear();
      onChanged((current) {
        final labels = {...current.labels};
        if (question.multi) {
          if (!labels.remove(label)) labels.add(label);
        } else {
          labels
            ..clear()
            ..add(label);
        }
        return AgentDmAnswerSelection(labels: labels);
      });
    }

    void typeOther(String text) {
      if (sendsOnTap) return;
      onChanged(
        (_) => text.trim().isEmpty
            ? AgentDmAnswerSelection.empty
            : AgentDmAnswerSelection(other: text),
      );
    }

    void sendOther() {
      if (!enabled || otherText.trim().isEmpty) return;
      onSubmit(AgentDmAnswerSelection(other: otherText));
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (question.header.trim().isNotEmpty)
          Text(
            question.header.trim(),
            style: context.textTheme.labelSmall?.copyWith(
              color: context.colors.onSurfaceVariant,
              fontWeight: FontWeight.w600,
            ),
          ),
        Semantics(
          header: true,
          child: Text(
            questionText,
            style: context.textTheme.bodyMedium?.copyWith(
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
        if (question.options.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: Grid.half),
            child: Wrap(
              spacing: Grid.half,
              runSpacing: Grid.half,
              children: [
                for (final option in question.options)
                  _OptionButton(
                    key: ValueKey(
                      'agent-dm-option-${question.qid}-${option.label}',
                    ),
                    option: option,
                    selected:
                        !sendsOnTap && selection.labels.contains(option.label),
                    toggles: !sendsOnTap,
                    enabled: enabled,
                    onTap: () => tapOption(option.label),
                  ),
              ],
            ),
          ),
        if (question.allowOther && enabled)
          Padding(
            padding: const EdgeInsets.only(top: Grid.half),
            child: Row(
              children: [
                Expanded(
                  child: TextField(
                    key: ValueKey('agent-dm-other-${question.qid}'),
                    controller: other,
                    enabled: enabled,
                    minLines: 1,
                    maxLines: 4,
                    textInputAction: sendsOnTap
                        ? TextInputAction.send
                        : TextInputAction.done,
                    onChanged: typeOther,
                    onSubmitted: sendsOnTap ? (_) => sendOther() : null,
                    decoration: const InputDecoration(
                      labelText: 'Other answer',
                      isDense: true,
                      border: OutlineInputBorder(),
                    ),
                  ),
                ),
                if (sendsOnTap) ...[
                  const SizedBox(width: Grid.half),
                  Semantics(
                    container: true,
                    button: true,
                    enabled: otherText.trim().isNotEmpty,
                    label: 'Send other answer',
                    excludeSemantics: true,
                    onTap: otherText.trim().isEmpty ? null : sendOther,
                    child: IconButton.filled(
                      key: ValueKey('agent-dm-other-send-${question.qid}'),
                      onPressed: otherText.trim().isEmpty ? null : sendOther,
                      icon: const Icon(BuzzIcons.arrowUp, size: 18),
                    ),
                  ),
                ],
              ],
            ),
          ),
      ],
    );
  }
}

class _OptionButton extends StatelessWidget {
  final AgentDmQuestionOption option;
  final bool selected;
  final bool toggles;
  final bool enabled;
  final VoidCallback onTap;

  const _OptionButton({
    super.key,
    required this.option,
    required this.selected,
    required this.toggles,
    required this.enabled,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final description = option.description.trim();
    final child = Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(option.label),
        if (description.isNotEmpty)
          Text(
            description,
            style: context.textTheme.labelSmall?.copyWith(
              color: context.colors.onSurfaceVariant,
            ),
          ),
      ],
    );
    final onPressed = enabled ? onTap : null;
    return Semantics(
      container: true,
      button: true,
      enabled: enabled,
      selected: toggles ? selected : null,
      label: option.label,
      hint: description.isEmpty ? null : description,
      excludeSemantics: true,
      onTap: onPressed,
      child: selected
          ? FilledButton.tonalIcon(
              onPressed: onPressed,
              icon: const Icon(BuzzIcons.check, size: 16),
              label: child,
            )
          : OutlinedButton(onPressed: onPressed, child: child),
    );
  }
}
