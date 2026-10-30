part of '../guest_suggestions_page.dart';

class _SuggestionRow extends HookConsumerWidget {
  const _SuggestionRow({
    super.key,
    required this.suggestion,
    required this.agentLabel,
  });

  final GuestSuggestion suggestion;
  final String agentLabel;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final busy = useState(false);

    Future<void> decide(bool accept) async {
      busy.value = true;
      await runGuestOwnerAction(
        context,
        ref,
        (client) =>
            client.decideSuggestion(suggestion.suggestionId, accept: accept),
        done: accept ? 'Grant created.' : 'Suggestion dismissed.',
      );
      if (context.mounted) busy.value = false;
    }

    return Padding(
      padding: EdgeInsets.symmetric(
        horizontal: AppListInset.of(context),
        vertical: Grid.twelve,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            suggestionQuestion(suggestion),
            style: context.textTheme.bodyLarge,
          ),
          _ThreadQuestionLine(suggestion: suggestion),
          const SizedBox(height: Grid.half),
          Text(
            '$agentLabel · ${suggestionDetail(suggestion)}',
            style: context.textTheme.bodySmall?.copyWith(
              color: context.colors.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: Grid.xxs),
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              TextButton(
                onPressed: busy.value ? null : () => unawaited(decide(false)),
                child: const Text('Dismiss'),
              ),
              const SizedBox(width: Grid.xxs),
              FilledButton(
                key: const ValueKey('guest-suggestion-accept'),
                onPressed: busy.value ? null : () => unawaited(decide(true)),
                child: const Text('Allow'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// The asked question under a thread proposal: labeled, quoted, italic and
/// muted behind a rule, and read by a screen reader as one node that starts
/// by saying it is quoted agent text.
class _ThreadQuestionLine extends StatelessWidget {
  const _ThreadQuestionLine({required this.suggestion});

  final GuestSuggestion suggestion;

  @override
  Widget build(BuildContext context) {
    final quote = suggestionThreadQuote(suggestion);
    if (quote == null) return const SizedBox.shrink();
    final muted = context.textTheme.bodySmall?.copyWith(
      color: context.colors.onSurfaceVariant,
    );
    return Padding(
      key: const ValueKey('guest-suggestion-thread-question'),
      padding: const EdgeInsets.only(top: Grid.half),
      child: Semantics(
        container: true,
        label: '$threadQuestionSpoken $threadQuestionLabel $quote',
        excludeSemantics: true,
        child: DecoratedBox(
          decoration: BoxDecoration(
            border: Border(
              left: BorderSide(color: context.colors.outlineVariant, width: 2),
            ),
          ),
          child: Padding(
            padding: const EdgeInsets.only(left: Grid.xxs),
            child: Text.rich(
              TextSpan(
                children: [
                  TextSpan(text: '$threadQuestionLabel '),
                  TextSpan(
                    text: quote,
                    style: const TextStyle(fontStyle: FontStyle.italic),
                  ),
                ],
              ),
              style: muted,
            ),
          ),
        ),
      ),
    );
  }
}
