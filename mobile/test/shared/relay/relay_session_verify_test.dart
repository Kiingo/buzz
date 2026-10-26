import 'dart:async';
import 'dart:collection';
import 'dart:convert';

import 'package:buzz/shared/auth/auth_provider.dart';
import 'package:buzz/shared/relay/relay.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart' as http_testing;
import 'package:nostr/nostr.dart' as nostr;

import 'served_event_fixture.dart';

/// Events the relay might serve, each but the first failing the session's
/// boundary checks, with the reason it must be dropped.
List<(Object? json, RelayEventRejection? rejection)> _served() {
  final genuine = _message('genuine', 20);
  final other = _message('other', 21);
  final json = genuine.toJson();
  return [
    (json, null),
    // The content was edited after the id was computed.
    ({...json, 'content': 'edited'}, RelayEventRejection.idMismatch),
    // The id was replaced with another event's.
    ({...json, 'id': other.id}, RelayEventRejection.idMismatch),
    ({...json, 'created_at': 99}, RelayEventRejection.idMismatch),
    ({...json, 'id': genuine.id.toUpperCase()}, RelayEventRejection.shape),
    ({...json, 'pubkey': 'alice'}, RelayEventRejection.shape),
    ({...json, 'sig': 'sig'}, RelayEventRejection.shape),
    ({...json, 'kind': -1}, RelayEventRejection.shape),
    ({...json}..remove('sig'), RelayEventRejection.shape),
    (
      {
        ...json,
        'tags': [
          ['h', 1],
        ],
      },
      RelayEventRejection.shape,
    ),
    ({...json, 'tags': 'h'}, RelayEventRejection.shape),
    ('not an event', RelayEventRejection.shape),
  ];
}

Map<RelayEventRejection, int> _expectedCounts() {
  final counts = <RelayEventRejection, int>{};
  for (final (_, rejection) in _served()) {
    if (rejection != null) counts[rejection] = (counts[rejection] ?? 0) + 1;
  }
  return counts;
}

void main() {
  test('HTTP queries drop events that fail the boundary checks', () async {
    final session = RelaySessionNotifier(
      httpClient: http_testing.MockClient(
        (_) async => http.Response(
          jsonEncode([for (final (json, _) in _served()) json]),
          200,
        ),
      ),
    );
    final container = ProviderContainer(
      overrides: [
        authProvider.overrideWith(() => _PendingAuthNotifier()),
        relaySessionProvider.overrideWith(() => session),
        relayConfigProvider.overrideWith(
          () => _FakeRelayConfigNotifier(nostr.Keys.generate().nsec),
        ),
      ],
    );
    addTearDown(container.dispose);

    final events = await container
        .read(relaySessionProvider.notifier)
        .queryRelay(const []);

    expect(events.map((event) => event.content), ['genuine']);
    expect(session.droppedEventCounts, _expectedCounts());
  });

  test(
    'live socket events that fail the checks never reach the subscriber',
    () async {
      final session = RelaySessionNotifier();
      final delivered = <NostrEvent>[];
      final subscribe = session.subscribe(_filter, delivered.add);
      session.debugHandleMessage(['EOSE', 'l-1']);
      final unsubscribe = await subscribe;

      for (final (json, _) in _served()) {
        session.debugHandleMessage(['EVENT', 'l-1', json]);
      }
      session.debugFlushEventBuffer();

      expect(delivered.map((event) => event.content), ['genuine']);
      expect(session.droppedEventCounts, _expectedCounts());
      unsubscribe();
    },
  );

  test('socket history keeps only events that pass the checks', () async {
    final socket = _RecordingRelaySocket();
    final session = RelaySessionNotifier()..debugAttachSocketForTest(socket);

    final history = session.fetchHistory(_filter);
    final subId = socket.messages.last[1] as String;
    for (final (json, _) in _served()) {
      session.debugHandleMessage(['EVENT', subId, json]);
    }
    session.debugHandleMessage(['EOSE', subId]);

    expect((await history).map((event) => event.content), ['genuine']);
    expect(session.droppedEventCounts, _expectedCounts());
  });

  test('an event that throws while it is read is one shape drop', () async {
    final session = RelaySessionNotifier();
    final delivered = <NostrEvent>[];
    final subscribe = session.subscribe(_filter, delivered.add);
    session.debugHandleMessage(['EOSE', 'l-1']);
    final unsubscribe = await subscribe;

    final genuine = _message('genuine', 20).toJson();
    session.debugHandleMessage(['EVENT', 'l-1', _ThrowingEvent()]);
    session.debugHandleMessage(['EVENT', 'l-1', genuine]);
    session.debugFlushEventBuffer();

    expect(delivered.map((event) => event.content), ['genuine']);
    expect(session.droppedEventCounts, {RelayEventRejection.shape: 1});
    unsubscribe();
  });
}

/// A payload whose fields throw something other than a [TypeError] when
/// read, as no decoded JSON value can.
class _ThrowingEvent extends MapBase<String, dynamic> {
  @override
  dynamic operator [](Object? key) => throw StateError('hostile field');

  @override
  void operator []=(String key, dynamic value) {}

  @override
  void clear() {}

  @override
  Iterable<String> get keys => const ['id'];

  @override
  dynamic remove(Object? key) => null;
}

const _channelId = '11111111-1111-4111-8111-111111111111';
const _filter = NostrFilter(
  kinds: EventKind.channelEventKinds,
  tags: {
    '#h': [_channelId],
  },
  limit: 50,
);

NostrEvent _message(String content, int createdAt) => servedEvent(
  kind: EventKind.streamMessageV2,
  tags: [
    ['h', _channelId],
  ],
  content: content,
  createdAt: createdAt,
);

class _FakeRelayConfigNotifier extends RelayConfigNotifier {
  _FakeRelayConfigNotifier(this._nsec);

  final String _nsec;

  @override
  RelayConfig build() =>
      RelayConfig(baseUrl: 'https://relay.example', nsec: _nsec);
}

class _PendingAuthNotifier extends AuthNotifier {
  @override
  Future<AuthState> build() => Completer<AuthState>().future;
}

class _RecordingRelaySocket extends RelaySocket {
  _RecordingRelaySocket()
    : super(
        wsUrl: 'wss://relay.example',
        nsec: null,
        onMessage: (_) {},
        onConnected: () {},
        onDisconnected: (_) {},
      );

  final List<List<dynamic>> messages = [];

  @override
  void send(List<dynamic> payload) => messages.add(payload);

  @override
  void dispose() {}
}
