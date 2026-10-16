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
