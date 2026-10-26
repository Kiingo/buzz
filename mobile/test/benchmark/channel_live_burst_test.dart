// Opt-in synthetic diagnostic; see README.md for invocation and limitations.
import 'dart:async';
import 'dart:convert';

import 'package:buzz/features/channels/channel_messages_provider.dart';
import 'package:buzz/shared/relay/relay.dart';
import 'package:buzz/shared/relay/relay_signature_backend.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../shared/relay/served_event_fixture.dart';

void main() {
  test(
    'buffered live channel delivery',
    () async {
      for (final historySize in [50, 500, 2000]) {
        for (final burstSize in [50, 200, 1000]) {
          // Discard the first two runs to reduce debug/JIT warm-up effects.
          for (var run = 0; run < 6; run++) {
            await _measureBurst(historySize, burstSize, run);
          }
        }
      }
    },
    skip: !const bool.fromEnvironment('BUZZ_RUN_BENCHMARKS'),
    timeout: const Timeout(Duration(minutes: 3)),
  );

  test(
    'live delivery behind isolate signature checks',
    () async {
      for (final burstSize in [500, 2000]) {
        // Signed once up front: pure-Dart signing is slower than checking.
        final burst = [
          for (var index = 0; index < burstSize; index++)
            _signedEvent('live-$index', _verifiedHistory + index),
        ];
        for (var run = 0; run < 6; run++) {
          await _measureVerifiedBurst(burst, run);
        }
      }
    },
    skip: !const bool.fromEnvironment('BUZZ_RUN_BENCHMARKS'),
    timeout: const Timeout(Duration(minutes: 10)),
  );
}

const _verifiedHistory = 50;

/// Time from the first live event to the last one reaching the channel,
/// with every signature checked by the pure-Dart isolate pool the app uses
/// off iOS. Each run is a fresh session, so nothing is cached as verified.
Future<void> _measureVerifiedBurst(List<NostrEvent> burst, int run) async {
  final session = _SyntheticSession(
    _verifiedHistory,
    signatureBackend: IsolateSignatureBackend.shared,
  );
  final container = ProviderContainer(
    overrides: [relaySessionProvider.overrideWith(() => session)],
  );
  try {
    final loaded = Completer<void>();
    final delivered = Completer<void>();
    final total = _verifiedHistory + burst.length;
    container.listen(channelMessagesProvider(_channelId), (_, next) {
      final length = next.value?.length;
      if (!loaded.isCompleted && length == _verifiedHistory) loaded.complete();
      if (!delivered.isCompleted && length == total) delivered.complete();
    });
    await loaded.future.timeout(const Duration(seconds: 5));

    final watch = Stopwatch()..start();
    for (final event in burst) {
      session.debugHandleMessage(['EVENT', 'l-1', event.toJson()]);
    }
    final enqueueUs = watch.elapsedMicroseconds;
    await delivered.future.timeout(const Duration(minutes: 2));
    final deliveryUs = watch.elapsedMicroseconds;

    expect(session.droppedEventCounts, isEmpty);
    if (run >= 2) {
      debugPrint(
        jsonEncode({
          'backend': 'isolate',
          'workers': IsolateSignatureBackend.shared.workers,
          'history': _verifiedHistory,
          'burst': burst.length,
          'run': run - 2,
          'enqueue_us': enqueueUs,
          'delivery_us': deliveryUs,
        }),
      );
    }
  } finally {
    container.dispose();
    await Future<void>.delayed(const Duration(milliseconds: 20));
  }
}

Future<void> _measureBurst(int historySize, int burstSize, int run) async {
  final session = _SyntheticSession(historySize);
  final container = ProviderContainer(
    overrides: [relaySessionProvider.overrideWith(() => session)],
  );
  try {
    final loaded = Completer<void>();
    container.listen(channelMessagesProvider(_channelId), (_, next) {
      if (!loaded.isCompleted && next.value?.length == historySize) {
        loaded.complete();
      }
    });
    await loaded.future.timeout(const Duration(seconds: 5));

    for (var index = 0; index < burstSize; index++) {
      session.debugHandleMessage([
        'EVENT',
        'l-1',
        _event('live-$index', historySize + index).toJson(),
      ]);
    }
    final tick = Completer<int>();
    final watch = Stopwatch()..start();
    Timer.run(() => tick.complete(watch.elapsedMicroseconds));
    session.debugFlushEventBuffer();
    final synchronousUs = watch.elapsedMicroseconds;
    final eventLoopDelayUs = await tick.future;

    expect(
      container.read(channelMessagesProvider(_channelId)).value!.length,
      historySize + burstSize,
    );
    if (run >= 2) {
      debugPrint(
        jsonEncode({
          'history': historySize,
          'burst': burstSize,
          'run': run - 2,
          'synchronous_us': synchronousUs,
          'event_loop_delay_us': eventLoopDelayUs,
        }),
      );
    }
  } finally {
    container.dispose();
    // The original 16 ms buffer timer remains armed after a debug flush.
    await Future<void>.delayed(const Duration(milliseconds: 20));
  }
}

const _channelId = '11111111-1111-4111-8111-111111111111';

// Live events pass the session's boundary checks, so the burst includes them.
NostrEvent _event(String name, int createdAt) => servedEvent(
  kind: EventKind.streamMessageV2,
  tags: const [
    ['h', _channelId],
  ],
  content: 'Synthetic message $name',
  createdAt: createdAt,
);

NostrEvent _signedEvent(String name, int createdAt) => signedEvent(
  kind: EventKind.streamMessageV2,
  tags: const [
    ['h', _channelId],
  ],
  content: 'Synthetic message $name',
  createdAt: createdAt,
);

class _SyntheticSession extends RelaySessionNotifier {
  final int historySize;

  // By default measures delivery with the shape and id checks only; the
  // isolate case passes the real pure-Dart signature backend.
  _SyntheticSession(
    this.historySize, {
    RelaySignatureBackend signatureBackend = trustingSignatures,
  }) : super(signatureBackend: signatureBackend);

  @override
  SessionState build() => const SessionState(status: SessionStatus.connected);

  @override
  Future<void Function()> subscribe(
    NostrFilter filter,
    void Function(NostrEvent) onEvent, {
    void Function(String message)? onClosed,
  }) {
    // Preserve the real subscription and buffer delivery implementation. This
    // fixture creates exactly one subscription, whose generated id is l-1.
    final ready = super.subscribe(filter, onEvent, onClosed: onClosed);
    debugHandleMessage(['EOSE', 'l-1']);
    return ready;
  }

  @override
  Future<List<NostrEvent>> queryRelay(
    List<NostrFilter> filters, {
    Duration timeout = const Duration(seconds: 8),
  }) async => [
    // Model retained history in one synthetic page; real windows page by 50.
    for (var index = historySize - 1; index >= 0; index--)
      _event('history-$index', index),
    NostrEvent(
      id: 'bounds',
      pubkey: 'synthetic-relay',
      createdAt: 0,
      kind: EventKind.channelWindowBounds,
      tags: const [
        ['d', '$_channelId:head'],
      ],
      content: jsonEncode({'has_more': false, 'next_cursor': null}),
      sig: 'synthetic-signature',
    ),
  ];
}
