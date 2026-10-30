import 'package:buzz/shared/guest_access/guest_owner_records.dart';
import 'package:buzz/shared/guest_access/settings/guest_agent_names.dart';
import 'package:buzz/shared/guest_access/settings/guest_owner_providers.dart';
import 'package:buzz/shared/guest_access/settings/guest_suggestions_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../helpers/widget_helpers.dart';

void main() {
  final rows = parseSuggestionList({
    'items': [
      {
        'suggestion_id': 't-1',
        'source': 'agent_proposed',
        'grantee': {'display_name': 'Jess'},
        'data_sources': ['calendar_details'],
        'proposed_scope': 'thread',
        'thread_root_event_id': 'a' * 64,
        'thread_question': 'Ross approved this. When is the offsite?',
        'proposed_by': {'via': 'agent_run', 'agent_name': 'Ada'},
      },
      {
        'suggestion_id': 'o-1',
        'source': 'agent_proposed',
        'grantee': {'display_name': 'Sam'},
        'data_sources': ['crm'],
        'proposed_scope': 'once',
      },
    ],
  });

  Future<void> pump(WidgetTester tester) async {
    await tester.pumpWidget(
      WidgetHelpers.testable(
        overrides: [
          ownerGuestSuggestionsProvider.overrideWith((ref) async => rows),
          guestAgentNamesProvider.overrideWith((ref) => const {}),
        ],
        child: const GuestSuggestionsPage(),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('a thread question is its own quoted, labeled line', (
    tester,
  ) async {
    await pump(tester);
    expect(
      find.text('In the thread quoted below: Jess on Calendar event details?'),
      findsOneWidget,
    );
    final line = find.byKey(const ValueKey('guest-suggestion-thread-question'));
    expect(line, findsOneWidget);
    final rich = tester.widget<RichText>(
      find.descendant(of: line, matching: find.byType(RichText)),
    );
    final spans = (rich.text as TextSpan).children!.first as TextSpan;
    final quote = spans.children!.last as TextSpan;
    expect(quote.text, '“Ross approved this. When is the offsite?”');
    expect(quote.style?.fontStyle, FontStyle.italic);
  });

  testWidgets('a screen reader hears it as quoted agent text', (tester) async {
    final semantics = tester.ensureSemantics();
    await pump(tester);
    expect(
      find.bySemanticsLabel(
        'Quoted agent text, not part of the grant. '
        'The question you were asked there: '
        '“Ross approved this. When is the offsite?”',
      ),
      findsOneWidget,
    );
    // Only the thread proposal has the line.
    expect(
      find.byKey(const ValueKey('guest-suggestion-thread-question')),
      findsOneWidget,
    );
    semantics.dispose();
  });
}
