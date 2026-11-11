import 'package:buzz/shared/guest_access/guest_access_client.dart';
import 'package:buzz/shared/surfaces/outside_app_cards.dart';
import 'package:buzz/shared/surfaces/outside_app_cards_page.dart';
import 'package:buzz/shared/surfaces/surface_client.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import '../../helpers/widget_helpers.dart';

const _id = '0192a6b0-0000-7000-8000-0000000000ac';
const _card = {
  'surfaceId': _id,
  'conversationId': _id,
  'revision': 3,
  'conversationTitle': 'From Claude',
  'appName': 'Claude',
};

class _Client extends SurfaceClient {
  bool refused = false;
  _Client()
    : super(
        route: const GuestAccessRoute(
          baseUrl: 'https://api.example.com',
          communityId: 'chat.example.com',
        ),
        nsec: 'unused-test-fixture',
      );
  @override
  Future<OutsideAppCardsPage> outsideApps({String? before}) async {
    if (refused) throw StateError('access_revoked');
    return decodeOutsideAppCards({
      'surfaces': [_card],
      'nextBefore': null,
    });
  }

  @override
  Future<LoadedSurface?> fetch(String id) async => null;
}

void main() {
  test(
    'decodes the owner conversation and preserves case-sensitive cursors',
    () {
      const cursor = 'v1.ABCdef0123456789_-ABCdef01234567';
      final page = decodeOutsideAppCards({
        'surfaces': [_card],
        'nextBefore': cursor,
      });
      expect(page.nextBefore, cursor);
      expect(page.surfaces.single.conversationTitle, 'From Claude');
      for (final value in [
        null,
        {},
        {
          'surfaces': [_card],
          'nextBefore': '../surfaces',
        },
        {'surfaces': List.filled(51, _card), 'nextBefore': null},
        {
          'surfaces': [
            {..._card, 'revision': 0},
          ],
          'nextBefore': null,
        },
      ]) {
        expect(() => decodeOutsideAppCards(value), throwsFormatException);
      }
    },
  );

  testWidgets(
    'the private view clears prior card labels when a refresh is refused',
    (tester) async {
      final client = _Client();
      await tester.pumpWidget(
        WidgetHelpers.testable(
          child: const OutsideAppCardsPageView(),
          overrides: [surfaceClientProvider.overrideWithValue(client)],
        ),
      );
      await tester.pump();
      await tester.pump();
      expect(find.text('From Claude'), findsOneWidget);
      client.refused = true;
      await tester.tap(find.byTooltip('Refresh cards'));
      await tester.pump();
      await tester.pump();
      expect(find.text('From Claude'), findsNothing);
      expect(find.text('Retry'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    },
  );
}
