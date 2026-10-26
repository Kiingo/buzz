import 'package:buzz/features/settings/settings_page.dart';
import 'package:buzz/shared/community/community_membership_provider.dart';
import 'package:buzz/shared/relay/relay.dart';
import 'package:buzz/shared/theme/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  Future<void> pumpSettings(
    WidgetTester tester,
    Map<RelayEventRejection, int> dropped,
  ) async {
    PackageInfo.setMockInitialValues(
      appName: 'Buzz',
      packageName: 'xyz.block.buzz',
      version: '0.16.0',
      buildNumber: '432',
      buildSignature: '',
    );
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    final container = ProviderContainer(
      overrides: [
        savedPrefsProvider.overrideWithValue(prefs),
        currentCommunityRoleProvider.overrideWithValue(
          const AsyncData<CommunityMemberRole?>(CommunityMemberRole.admin),
        ),
        relaySessionProvider.overrideWith(() => _DroppingSession(dropped)),
      ],
    );
    addTearDown(container.dispose);
    container.read(relaySessionProvider);
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          theme: AppTheme.light(),
          home: SettingsPage(
            profileHeader: const SizedBox.shrink(),
            identityRecoveryPageBuilder: (_) => const SizedBox.shrink(),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    // The note sits just above the version, at the end of the list.
    await tester.scrollUntilVisible(find.text('v0.16.0 (432)'), 200);
    await tester.pumpAndSettle();
  }

  testWidgets('says how many relay events failed which checks', (tester) async {
    await pumpSettings(tester, {
      RelayEventRejection.shape: 2,
      RelayEventRejection.badSignature: 1,
    });

    expect(
      find.text(
        'Dropped 3 relay events that did not pass checks '
        '(2 malformed, 1 badly signed)',
      ),
      findsOneWidget,
    );
  });

  testWidgets('tells an unchecked event from a badly signed one', (
    tester,
  ) async {
    await pumpSettings(tester, {
      RelayEventRejection.badSignature: 1,
      RelayEventRejection.verifierUnavailable: 4,
    });

    expect(
      find.text(
        'Dropped 5 relay events that did not pass checks '
        '(1 badly signed, 4 unchecked)',
      ),
      findsOneWidget,
    );
  });

  testWidgets('says nothing when no event was dropped', (tester) async {
    await pumpSettings(tester, const {});

    expect(find.textContaining('relay event'), findsNothing);
  });
}

class _DroppingSession extends RelaySessionNotifier {
  _DroppingSession(this._dropped);

  final Map<RelayEventRejection, int> _dropped;

  @override
  SessionState build() => const SessionState(status: SessionStatus.connected);

  @override
  Map<RelayEventRejection, int> get droppedEventCounts => _dropped;
}
