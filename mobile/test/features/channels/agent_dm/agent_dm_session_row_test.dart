import 'package:buzz/features/channels/agent_dm/agent_dm_session_row.dart';
import 'package:buzz/shared/agent_dm/agent_dm_session_setup.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

const _agent =
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const _setup = AgentDmSessionSetup(
  revision: 1,
  model: 'opus',
  effort: 'high',
  label: 'Claude Code · Opus 5.5 · High',
  models: [
    AgentDmSetupModel(id: 'opus', label: 'Opus 5.5', efforts: ['low', 'high']),
    AgentDmSetupModel(id: 'sonnet', label: 'Sonnet 5', efforts: ['low']),
  ],
  effortLabels: {'low': 'Low', 'high': 'High'},
  canChangeModel: true,
  canChangeEffort: true,
  vitals: AgentDmSessionVitals(
    contextTokens: 50000,
    contextWindow: 200000,
    contextPercent: 25,
  ),
);

class _FakeActions implements AgentDmSessionActions {
  _FakeActions({
    this.outcome = AgentDmStopOutcome.stopped,
    this.stopFails = false,
  });

  final AgentDmStopOutcome outcome;
  final bool stopFails;
  int stops = 0;
  final changes = <Map<String, String?>>[];

  @override
  Future<AgentDmSessionSetup> change(
    String agentPubkey,
    AgentDmSessionSetup? before,
    Map<String, String?> choice,
  ) async {
    changes.add(choice);
    return _setup;
  }

  @override
  Future<AgentDmStopOutcome> stop(String agentPubkey) async {
    stops += 1;
    if (stopFails) throw StateError('no');
    return outcome;
  }
}

Future<void> _pump(
  WidgetTester tester, {
  required AgentDmSessionSetup? setup,
  required bool working,
  _FakeActions? actions,
}) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        agentDmSessionSetupProvider(_agent).overrideWith((_) async => setup),
        agentDmSessionActionsProvider.overrideWithValue(
          actions ?? _FakeActions(),
        ),
      ],
      child: MaterialApp(
        home: Scaffold(
          body: AgentDmSessionRow(agentPubkey: _agent, working: working),
        ),
      ),
    ),
  );
  await tester.pump();
}

void main() {
  testWidgets('shows nothing for an agent with no host', (tester) async {
    await _pump(tester, setup: null, working: true);
    expect(find.byKey(const ValueKey('agent-dm-session-row')), findsNothing);
    expect(find.byKey(const ValueKey('agent-dm-stop')), findsNothing);
  });

  testWidgets('shows the session line, and Stop only while working', (
    tester,
  ) async {
    await _pump(tester, setup: _setup, working: false);
    expect(find.text('Claude Code · Opus 5.5 · High · 25%'), findsOneWidget);
    expect(find.byKey(const ValueKey('agent-dm-stop')), findsNothing);

    await _pump(tester, setup: _setup, working: true);
    expect(find.byKey(const ValueKey('agent-dm-stop')), findsOneWidget);
  });

  testWidgets('Stop says what happened', (tester) async {
    final actions = _FakeActions(outcome: AgentDmStopOutcome.notRunning);
    await _pump(tester, setup: _setup, working: true, actions: actions);
    await tester.tap(find.byKey(const ValueKey('agent-dm-stop')));
    await tester.pump();
    await tester.pump();
    expect(actions.stops, 1);
    expect(find.text('Nothing is running to stop.'), findsOneWidget);
  });

  testWidgets('a failed Stop says so in one sentence', (tester) async {
    await _pump(
      tester,
      setup: _setup,
      working: true,
      actions: _FakeActions(stopFails: true),
    );
    await tester.tap(find.byKey(const ValueKey('agent-dm-stop')));
    await tester.pump();
    await tester.pump();
    expect(find.text("Couldn't stop the agent. Try again."), findsOneWidget);
  });

  testWidgets('the panel changes the model from the next turn', (tester) async {
    final actions = _FakeActions();
    await _pump(tester, setup: _setup, working: false, actions: actions);
    await tester.tap(find.byKey(const ValueKey('agent-dm-session-row')));
    await tester.pumpAndSettle();
    expect(find.text('A change applies from the next turn.'), findsOneWidget);
    expect(find.text('Context 25% · 50k of 200k'), findsOneWidget);
    await tester.tap(find.text('Sonnet 5'));
    await tester.pump();
    expect(actions.changes, [
      {'model': 'sonnet'},
    ]);
  });

  testWidgets('the row has one screen reader stop for the panel', (
    tester,
  ) async {
    final handle = tester.ensureSemantics();
    await _pump(tester, setup: _setup, working: false);
    expect(
      find.bySemanticsLabel('Session: Claude Code · Opus 5.5 · High · 25%'),
      findsOneWidget,
    );
    handle.dispose();
  });
}
