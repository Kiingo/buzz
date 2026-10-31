import 'package:buzz/shared/surfaces/agent_surface_view.dart';
import 'package:buzz/shared/surfaces/surface_client.dart';
import 'package:buzz/shared/surfaces/surface_host.dart';
import 'package:buzz/shared/surfaces/surface_model.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../helpers/widget_helpers.dart';

const _id = '0b5c1f7e-8a7d-4d1e-9a51-3c2f1e0d9b88';

/// An email_draft card as the server sends it (the shape of the catalog's
/// edge-email-sent and edge-email-send-failed fixtures).
Map<String, Object?> _card({
  String state = 'submitted',
  Map<String, Object?>? status,
  String template = 'email_draft',
}) => {
  'id': _id,
  'revision': 4,
  'state': state,
  'template': template,
  'agentName': 'Dana',
  'viewer': {'canEdit': state == 'active', 'canAct': state == 'active'},
  'webUrl': 'https://app.kiingo.com/surfaces/$_id',
  'status': ?status,
  'spec': {
    'title': 'Reply to Dana',
    'root': 'root',
    'components': [
      {
        'id': 'root',
        'type': 'Stack',
        'props': {
          'children': ['body', 'bar'],
        },
      },
      {
        'id': 'body',
        'type': 'Text',
        'props': {
          'text': {'path': '/body'},
        },
      },
      {
        'id': 'bar',
        'type': 'ActionBar',
        'props': {
          'children': ['send'],
        },
      },
      {
        'id': 'send',
        'type': 'Button',
        'props': {'action': 'send'},
      },
    ],
    'data': {
      'to': [
        {'email': 'dana@acme.com', 'name': 'Dana Lee'},
      ],
      'cc': [
        {'email': 'sam@acme.com', 'name': 'sam@acme.com'},
      ],
      'subject': 'Re: Q4 plan',
      'body': 'The plan looks right to me.',
    },
    'actions': {
      'send': {'kind': 'send_message', 'label': 'Send', 'text': 'Send it'},
    },
  },
};

const _sentStatus = {
  'text': 'Sent to dana@acme.com',
  'tone': 'success',
  'actionId': 'send_confirmed',
  'kind': 'sent',
  'sent': {
    'at': '2026-10-31T18:05:00.000Z',
    'to': ['dana@acme.com'],
    'cc': ['sam@acme.com'],
    'bcc': <String>[],
    'subject': 'Re: Q4 plan',
    'messageId': 'AAMk-1',
  },
};

const _failedStatus = {
  'text': 'Not sent: Outlook refused it before sending. Nothing went out.',
  'tone': 'danger',
  'kind': 'send_failed',
};

Future<List<String>> _pump(WidgetTester tester, Surface surface) async {
  final sent = <String>[];
  await tester.pumpWidget(
    WidgetHelpers.testable(
      child: SingleChildScrollView(
        child: AgentSurfaceView(
          loaded: LoadedSurface(
            origin: 'https://api.kiingo.com',
            surface: surface,
          ),
          host: SurfaceHost(
            openUrl: (_) {},
            sendMessage: (text, _) => sent.add(text),
            agentName: 'Dana',
          ),
        ),
      ),
    ),
  );
  return sent;
}

void main() {
  setUp(resetSurfaceRevisionTaps);

  group('sentEmailOf', () {
    test('reads the server sent record', () {
      final surface = decodeSurface(_card(status: _sentStatus))!;
      expect(surface.status?.kind, SurfaceStatusKind.sent);
      final sent = sentEmailOf(surface)!;
      expect(sent.to, ['dana@acme.com']);
      expect(sent.cc, ['sam@acme.com']);
      expect(sent.subject, 'Re: Q4 plan');
      expect(sent.at, '2026-10-31T18:05:00.000Z');
    });

    test('a failed send is not sent', () {
      final surface = decodeSurface(
        _card(state: 'active', status: _failedStatus),
      )!;
      expect(surface.status?.kind, SurfaceStatusKind.sendFailed);
      expect(sentEmailOf(surface), isNull);
    });

    test('only an email_draft card is a sent email', () {
      final surface = decodeSurface(
        _card(status: _sentStatus, template: 'checklist'),
      )!;
      expect(sentEmailOf(surface), isNull);
    });

    test('an unknown kind decodes as no kind', () {
      final surface = decodeSurface(
        _card(status: {..._sentStatus, 'kind': 'later'}),
      )!;
      expect(surface.status?.kind, isNull);
      expect(sentEmailOf(surface), isNull);
    });

    test('recipients put the address first, then a plain name', () {
      final surface = decodeSurface(_card(status: _sentStatus))!;
      expect(
        sentRecipientsLine(surface, sentEmailOf(surface)!),
        'To dana@acme.com (Dana Lee) · Cc sam@acme.com',
      );
    });
  });

  testWidgets('a sent card collapses to a Sent row with no Send', (
    tester,
  ) async {
    final sent = await _pump(
      tester,
      decodeSurface(_card(status: _sentStatus))!,
    );
    expect(find.text('Sent to dana@acme.com'), findsNothing);
    expect(find.textContaining('dana@acme.com (Dana Lee)'), findsOneWidget);
    expect(find.text('Re: Q4 plan'), findsOneWidget);
    expect(find.text('The plan looks right to me.'), findsNothing);
    expect(find.text('Send'), findsNothing);

    await tester.tap(find.textContaining('dana@acme.com (Dana Lee)'));
    await tester.pumpAndSettle();
    expect(find.text('The plan looks right to me.'), findsOneWidget);
    expect(find.text('Send'), findsNothing);
    expect(sent, isEmpty);
  });

  testWidgets('Bcc shows only open, never on the compact row (79)', (
    tester,
  ) async {
    final status = {
      ..._sentStatus,
      'sent': {
        ...(_sentStatus['sent']! as Map<String, Object?>),
        'bcc': ['ops@acme.com'],
      },
    };
    await _pump(tester, decodeSurface(_card(status: status))!);
    expect(find.textContaining('ops@acme.com'), findsNothing);
    await tester.tap(find.textContaining('dana@acme.com (Dana Lee)'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Bcc ops@acme.com'), findsOneWidget);
  });

  for (final state in ['dismissed', 'closed']) {
    testWidgets('a $state sent card is a plain Sent (79)', (tester) async {
      await _pump(
        tester,
        decodeSurface(_card(state: state, status: _sentStatus))!,
      );
      expect(find.text('Sent'), findsOneWidget);
      expect(find.textContaining('dana@acme.com'), findsNothing);
      expect(find.text('Re: Q4 plan'), findsNothing);
      expect(find.text('The plan looks right to me.'), findsNothing);
      expect(find.text('Dismissed'), findsNothing);
      expect(find.text('Closed'), findsNothing);
    });
  }

  testWidgets('a failed send stays open, with its failure and Send', (
    tester,
  ) async {
    await _pump(
      tester,
      decodeSurface(_card(state: 'active', status: _failedStatus))!,
    );
    expect(
      find.text(
        'Not sent: Outlook refused it before sending. Nothing went out.',
      ),
      findsOneWidget,
    );
    expect(find.text('The plan looks right to me.'), findsOneWidget);
    expect(find.text('Send'), findsOneWidget);
  });
}
