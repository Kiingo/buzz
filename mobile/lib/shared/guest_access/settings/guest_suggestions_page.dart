import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../../theme/theme.dart';
import '../../widgets/app_list_card.dart';
import '../../widgets/app_list_inset.dart';
import '../guest_owner_copy.dart';
import '../guest_owner_records.dart';
import 'guest_agent_names.dart';
import 'guest_owner_list_state.dart';
import 'guest_owner_page_scaffold.dart';
import 'guest_owner_providers.dart';

part 'guest_suggestions_page/suggestion_row.dart';

/// Learned-grant suggestions from what the owner keeps approving: Allow
/// creates a grant (revocable any time), Dismiss drops the suggestion.
class GuestSuggestionsPage extends ConsumerWidget {
  const GuestSuggestionsPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final suggestions = ref.watch(ownerGuestSuggestionsProvider);
    final names = ref.watch(guestAgentNamesProvider);
    return GuestOwnerPageScaffold(
      title: 'Suggestions',
      intro:
          'Proposed by your agents, or based on what you keep approving. '
          'Allowing creates a grant you can revoke any time.',
      children: [
        GuestOwnerListState<List<GuestSuggestion>>(
          value: suggestions,
          isEmpty: (rows) => rows.isEmpty,
          emptyText: 'No suggestions right now.',
          onRetry: () => ref.invalidate(ownerGuestSuggestionsProvider),
          builder: (rows) => AppListCard(
            verticalPadding: Grid.twelve,
            dividerIndent: Grid.xs,
            children: [
              for (final row in rows)
                _SuggestionRow(
                  key: ValueKey(row.suggestionId),
                  suggestion: row,
                  agentLabel: guestAgentScopeLabel(names, row.guestEndpointId),
                ),
            ],
          ),
        ),
      ],
    );
  }
}
