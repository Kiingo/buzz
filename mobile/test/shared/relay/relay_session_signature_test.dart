import 'dart:async';
import 'dart:io';

import 'package:buzz/shared/relay/relay.dart';
import 'package:buzz/shared/relay/relay_signature_backend.dart';
import 'package:buzz/shared/relay/relay_signature_native.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import 'served_event_fixture.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('a live subscription', () {
    test('delivers nothing until the events ahead are verified', () async {
      final backend = _HeldBackend();
      final session = RelaySessionNotifier(signatureBackend: backend);
      final delivered = <String>[];
      final subscribe = session.subscribe(
        _filter,
        (event) => delivered.add(event.content),
      );
      session.debugHandleMessage(['EOSE', 'l-1']);
      final unsubscribe = await subscribe;

      final first = _message('first', 20);
      final second = _message('second', 21);
      session.debugHandleMessage(['EVENT', 'l-1', first.toJson()]);
      session.debugHandleMessage(['EVENT', 'l-1', second.toJson()]);
      backend.settle(second.id, true);
      await pumpEventQueue();
      session.debugFlushEventBuffer();
      expect(delivered, isEmpty);

      backend.settle(first.id, true);
      await pumpEventQueue();
      session.debugFlushEventBuffer();
      expect(delivered, ['first', 'second']);
      unsubscribe();
    });

    test('signals ready only after the replay ahead is verified', () async {
      final backend = _HeldBackend();
      final session = RelaySessionNotifier(signatureBackend: backend);
      final delivered = <String>[];
      final statuses = <RelaySubscriptionStatus>[];
      final subscribe = session.subscribeWithStatus(
        _filter,
        (event) => delivered.add(event.content),
        onStatusChanged: statuses.add,
      );
      final forged = _message('forged', 21, secretKey: otherSecretKey);
      session.debugHandleMessage(['EVENT', 'l-1', _message('a', 20).toJson()]);
      session.debugHandleMessage([
        'EVENT',
        'l-1',
        {...forged.toJson(), 'sig': _message('b', 21).sig},
      ]);
      session.debugHandleMessage(['EOSE', 'l-1']);
      await pumpEventQueue();
      expect(statuses, isEmpty);

      backend.settleAll((id) => id != forged.id);
      await pumpEventQueue();
      expect(statuses, [RelaySubscriptionStatus.ready]);
      expect(delivered, ['a']);
      expect(session.droppedEventCounts, {RelayEventRejection.badSignature: 1});
      (await subscribe)();
    });

    test('drops held events when the connection drops', () async {
      final backend = _HeldBackend();
      final session = RelaySessionNotifier(signatureBackend: backend);
      final container = ProviderContainer(
        overrides: [relaySessionProvider.overrideWith(() => session)],
      );
      addTearDown(container.dispose);
      container.read(relaySessionProvider);
      session.debugAttachSocketForTest(_SilentRelaySocket());
      final delivered = <NostrEvent>[];
      final subscribe = session.subscribe(_filter, delivered.add);
      session.debugHandleMessage(['EOSE', 'l-1']);
      final unsubscribe = await subscribe;

      final held = _message('held', 20);
      session.debugHandleMessage(['EVENT', 'l-1', held.toJson()]);
      session.debugHandleDisconnected();
      backend.settle(held.id, true);
      await pumpEventQueue();
      session.debugFlushEventBuffer();

      expect(delivered, isEmpty);
      unsubscribe();
    });
  });

  test('socket history completes only with verified events', () async {
    final backend = _HeldBackend();
    final socket = _SilentRelaySocket();
    final session = RelaySessionNotifier(signatureBackend: backend)
      ..debugAttachSocketForTest(socket);
    var completed = false;
    final history = session.fetchHistory(_filter)
      ..then((_) => completed = true);
    final subId = socket.messages.last[1] as String;
    final kept = _message('kept', 20);
    final forged = _message('forged', 21, secretKey: otherSecretKey);
    session.debugHandleMessage(['EVENT', subId, kept.toJson()]);
    session.debugHandleMessage([
      'EVENT',
      subId,
      {...forged.toJson(), 'sig': _message('x', 21).sig},
    ]);
    session.debugHandleMessage(['EOSE', subId]);
    await pumpEventQueue();
    expect(completed, isFalse);

    backend.settle(kept.id, true);
    backend.settle(forged.id, false);
    expect((await history).map((event) => event.content), ['kept']);
  });

  test('a verified (id, sig, pubkey) is not checked again', () async {
    final backend = _CountingBackend();
    final session = RelaySessionNotifier(signatureBackend: backend);
    final subscribe = session.subscribe(_filter, (_) {});
    session.debugHandleMessage(['EOSE', 'l-1']);
    final unsubscribe = await subscribe;

    final event = _message('same', 20);
    // BIP-340 signing is randomized: the same event, signed again, carries
    // a different valid signature, which is a different cache entry.
    final resigned = _message('same', 20);
    expect(resigned.id, event.id);
    expect(resigned.sig, isNot(event.sig));
    for (final copy in [event, event, resigned, event, resigned]) {
      session.debugHandleMessage(['EVENT', 'l-1', copy.toJson()]);
    }

    expect(backend.calls, 2);
    unsubscribe();
  });

  test('the isolate pool gives the official BIP-340 answers', () async {
    final vectors = File(
      'ios/BuzzPushKit/Tests/BuzzPushKitTests/CryptoFixtures/bip340.csv',
    ).readAsLinesSync().skip(1).map((row) => row.split(','));
    final backend = IsolateSignatureBackend(workers: 2, chunkSize: 4);
    final checks = <Future<bool>>[];
    final expected = <bool>[];
    for (final columns in vectors) {
      if (columns[4].length != 64) continue;
      checks.add(
        backend.verify(
          columns[4].toLowerCase(),
          columns[2].toLowerCase(),
          columns[5].toLowerCase(),
        ),
      );
      expected.add(columns[6] == 'TRUE');
    }

    expect(expected, hasLength(15));
    expect(await Future.wait(checks), expected);
  });

  group('the native backend', () {
    const channel = MethodChannel('buzz/relay_signature_test');
    final event = _message('native', 20);

    void answer(Object? Function() reply) {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (_) async => reply());
      addTearDown(
        () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(channel, null),
      );
    }

    Future<bool> verify(NativeSignatureBackend backend) async =>
        backend.verify(event.id, event.pubkey, event.sig);

    test('fails closed when the host has no check', () async {
      answer(() => throw PlatformException(code: 'unavailable'));
      final backend = NativeSignatureBackend(channel: channel);
      expect(await verify(backend), isFalse);
    });

    test('fails closed on a zero address', () async {
      answer(() => 0);
      expect(await verify(NativeSignatureBackend(channel: channel)), isFalse);
    });

    test('waits a bounded time for the host to register', () async {
      var asks = 0;
      answer(() {
        asks++;
        return null; // An unanswered call reads as an unregistered channel.
      });
      final backend = NativeSignatureBackend(
        channel: channel,
        retryDelay: Duration.zero,
      );
      expect(await verify(backend), isFalse);
      expect(asks, 8);
    });
  });
}

const _channelId = '11111111-1111-4111-8111-111111111111';
const _filter = NostrFilter(
  kinds: EventKind.channelEventKinds,
  tags: {
    '#h': [_channelId],
  },
  limit: 50,
);

NostrEvent _message(
  String content,
  int createdAt, {
  String secretKey = fixtureSecretKey,
}) => signedEvent(
  kind: EventKind.streamMessageV2,
  tags: [
    ['h', _channelId],
  ],
  content: content,
  createdAt: createdAt,
  secretKey: secretKey,
);

/// Holds every check until the test settles it.
class _HeldBackend implements RelaySignatureBackend {
  final _pending = <String, Completer<bool>>{};

  @override
  Future<bool> verify(String id, String pubkey, String sig) =>
      (_pending[id] = Completer<bool>()).future;

  void settle(String id, bool valid) => _pending.remove(id)!.complete(valid);

  void settleAll(bool Function(String id) valid) {
    for (final id in _pending.keys.toList()) {
      settle(id, valid(id));
    }
  }
}

class _CountingBackend implements RelaySignatureBackend {
  int calls = 0;

  @override
  FutureOr<bool> verify(String id, String pubkey, String sig) {
    calls++;
    return verifyBip340(id, pubkey, sig);
  }
}

class _SilentRelaySocket extends RelaySocket {
  _SilentRelaySocket()
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
