import 'package:buzz/features/channels/agent_dm/agent_dm_expanded_surface.dart';
import 'package:buzz/shared/surfaces/agent_surface_view.dart';
import 'package:buzz/shared/surfaces/surface_client.dart';
import 'package:buzz/shared/surfaces/surface_host.dart';
import 'package:buzz/shared/surfaces/surface_model.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../../../helpers/widget_helpers.dart';

const _id = '5f0c2a9e-3b7d-4c1a-8e2f-6d9b0a1c3e57';
const _key = (id: _id, revision: 1);
final _signer = 'ab' * 32;

/// The surface the host returns, naming [agent] as its agent.
LoadedSurface _read(Map<String, Object?> agent) => LoadedSurface(
  origin: 'https://api.kiingo.com',
  surface: decodeSurface({
    'id': _id,
    'revision': 1,
    'agent': agent,
    'spec': {
      'title': 'Fixture card',
      'root': 'root',
      'components': const [
        {
          'id': 'root',
          'type': 'Text',
          'props': {'text': 'Card body'},
        },
      ],
    },
  })!,
);

final _host = SurfaceHost(
  openUrl: (_) {},
  sendMessage: (_, _) {},
  agentName: 'Dana',
);

void main() {
  setUp(resetSurfaceRevisionTaps);

  /// Opens the sheet's body on the first read, then re-reads the same
  /// surface returning [next] while it stays open.
  Future<void> rereadWhileOpen(WidgetTester tester, LoadedSurface? next) async {
    LoadedSurface? current = _read({
      'id': 'x',
      'name': 'Dana',
      'buzzPubkey': _signer,
    });
    await tester.pumpWidget(
      WidgetHelpers.testable(
        overrides: [
          agentSurfaceProvider.overrideWith((ref, key) async => current),
        ],
        child: AgentDmExpandedSurface(
          surfaceKey: _key,
          signer: _signer,
          host: _host,
        ),
      ),
    );
    await tester.pump();
    expect(find.byType(AgentSurfaceView), findsOneWidget);
    expect(find.text('Card body'), findsOneWidget);

    current = next;
    ProviderScope.containerOf(
      tester.element(find.byType(AgentDmExpandedSurface)),
    ).invalidate(agentSurfaceProvider(_key));
    await tester.pump();
    await tester.pump();
  }

  testWidgets('a re-read naming another agent key draws nothing (S-b)', (
    tester,
  ) async {
    await rereadWhileOpen(
      tester,
      _read({'id': 'x', 'name': 'Dana', 'buzzPubkey': 'cd' * 32}),
    );
    expect(find.byType(AgentSurfaceView), findsNothing);
    expect(find.text('Card body'), findsNothing);
  });

  testWidgets('a re-read naming no agent key draws nothing (S-b)', (
    tester,
  ) async {
    await rereadWhileOpen(tester, _read({'id': 'x', 'name': 'Dana'}));
    expect(find.byType(AgentSurfaceView), findsNothing);
    expect(find.text('Card body'), findsNothing);
  });

  testWidgets('a re-read naming the key only as agent.pubkey draws nothing', (
    tester,
  ) async {
    await rereadWhileOpen(
      tester,
      _read({'id': 'x', 'name': 'Dana', 'pubkey': _signer}),
    );
    expect(find.byType(AgentSurfaceView), findsNothing);
  });

  testWidgets('a re-read under the same agent key still draws', (tester) async {
    await rereadWhileOpen(
      tester,
      _read({'id': 'x', 'name': 'Dana', 'buzzPubkey': _signer.toUpperCase()}),
    );
    expect(find.byType(AgentSurfaceView), findsOneWidget);
    expect(find.text('Card body'), findsOneWidget);
  });
}
