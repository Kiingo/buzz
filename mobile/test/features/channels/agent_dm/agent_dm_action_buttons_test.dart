import 'package:buzz/features/channels/agent_dm/agent_dm_action_buttons.dart';
import 'package:buzz/features/channels/agent_dm/agent_dm_sent_provider.dart';
import 'package:buzz/shared/agent_dm/agent_dm_markers.dart';
import 'package:buzz/shared/relay/relay.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../../../helpers/widget_helpers.dart';

final _actions = readAgentDmActions(const [
  ['buzz-action', 'retry', 'Retry', 'retry', 'primary', 'ref-retry'],
  [
    'buzz-action',
    'continue_on_claude',
    'Continue on Claude',
    'continue on claude',
    'secondary',
    'ref-continue',
  ],
]);

class _FixedRelayConfig extends RelayConfigNotifier {
  @override
  RelayConfig build() => const RelayConfig(baseUrl: 'https://relay.example');
}

ProviderContainer _container() => ProviderContainer(
  overrides: [
    relayConfigProvider.overrideWith(_FixedRelayConfig.new),
    myPubkeyProvider.overrideWithValue('me'),
  ],
);

void main() {
  testWidgets(
    'primary renders filled, secondary outlined; taps pass the action',
    (tester) async {
      final tapped = <AgentDmAction>[];
      await tester.pumpWidget(
        WidgetHelpers.testable(
          child: AgentDmActionButtons(
            actions: _actions,
            enabled: true,
            onTap: tapped.add,
          ),
        ),
      );
      expect(find.widgetWithText(FilledButton, 'Retry'), findsOneWidget);
      expect(
        find.widgetWithText(OutlinedButton, 'Continue on Claude'),
        findsOneWidget,
      );
      await tester.tap(find.text('Retry'));
      expect(tapped.single.ref, 'ref-retry');
    },
  );

  testWidgets('disabled buttons ignore taps', (tester) async {
    final tapped = <AgentDmAction>[];
    await tester.pumpWidget(
      WidgetHelpers.testable(
        child: AgentDmActionButtons(
          actions: _actions,
          enabled: false,
          onTap: tapped.add,
        ),
      ),
    );
    await tester.tap(find.text('Retry'), warnIfMissed: false);
    expect(tapped, isEmpty);
    expect(
      tester
          .widget<FilledButton>(find.widgetWithText(FilledButton, 'Retry'))
          .onPressed,
      isNull,
    );
  });

  group('AgentDmSentNotifier', () {
    test('a successful send marks the key sent and blocks repeats', () async {
      final container = _container();
      addTearDown(container.dispose);
      final notifier = container.read(agentDmSentProvider.notifier);
      var calls = 0;
      expect(await notifier.send('k', () async => calls++), isTrue);
      expect(container.read(agentDmSentProvider)['k'], AgentDmSendStatus.sent);
      expect(await notifier.send('k', () async => calls++), isFalse);
      expect(calls, 1);
    });

    test('a failed send clears the key so the person can retry', () async {
      final container = _container();
      addTearDown(container.dispose);
      final notifier = container.read(agentDmSentProvider.notifier);
      await expectLater(
        notifier.send('k', () async => throw StateError('offline')),
        throwsStateError,
      );
      expect(container.read(agentDmSentProvider), isEmpty);
    });
  });
}
