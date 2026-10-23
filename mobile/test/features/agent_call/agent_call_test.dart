import 'dart:async';
import 'dart:convert';

import 'package:buzz/features/agent_call/agent_call_api.dart';
import 'package:buzz/features/agent_call/agent_call_controller.dart';
import 'package:buzz/features/agent_call/agent_call_feed.dart';
import 'package:buzz/features/agent_call/agent_call_media.dart';
import 'package:buzz/features/agent_call/agent_call_screen.dart';
import 'package:buzz/shared/guest_access/guest_access_client.dart';
import 'package:buzz/shared/huddle/huddle.dart';
import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:hooks_riverpod/misc.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:nostr/nostr.dart' as nostr;

const _call = '0192a6b0-0000-7000-8000-0000000000ac';
const _channel = '0192a6b0-0000-7000-8000-0000000000af';
final _agent = 'b' * 64;

Map<String, Object?> _feed({String state = 'live', List<Object?>? asks}) => {
  'callId': _call,
  'rev': 'r1',
  'state': state,
  'agent': {'id': 'a', 'name': 'Alfred'},
  'destination': {'kind': 'buzz_dm', 'label': 'your Buzz chat with Alfred'},
  'asks': asks ?? const [],
  'humanAsk': null,
  'endedAt': null,
};

/// A Huddle's in-session flag the call reads (flipped by a test).
final _huddleInSession = NotifierProvider<_Flag, bool>(_Flag.new);

final class _Flag extends Notifier<bool> {
  @override
  bool build() => false;

  void raise() => state = true;
}

class _FakeMedia implements AgentCallMedia {
  final events$ = StreamController<AgentCallMediaEventData>.broadcast();
  final calls = <String>[];
  String? answer;

  /// Runs inside `begin`, as if while the microphone prompt was up.
  void Function()? onBegin;

  @override
  Stream<AgentCallMediaEventData> get events => events$.stream;

  @override
  Future<AgentCallOffer> begin({required String agentName}) async {
    calls.add('begin:$agentName');
    onBegin?.call();
    return const AgentCallOffer(sdp: 'v=0 offer', systemCallUI: 'callkit');
  }

  @override
  Future<void> accept(String sdpAnswer) async {
    answer = sdpAnswer;
  }

  @override
  Future<void> setMuted(bool muted) async => calls.add('muted:$muted');

  @override
  Future<void> end() async => calls.add('end');
}

void main() {
  group('AgentCallApi', () {
    test('starts from the DM, signed over the exact body', () async {
      final keys = nostr.Keys.generate();
      http.Request? sent;
      final api = AgentCallApi(
        origin: 'https://api.example.com',
        communityId: 'chat.example.com',
        nsec: keys.nsec,
        httpClient: MockClient((request) async {
          sent = request;
          return http.Response(
            jsonEncode({
              'callId': _call,
              'sdpAnswer': 'v=0 answer',
              'executeUntil': null,
            }),
            201,
          );
        }),
      );
      final started = await api.start(
        agentPubkey: _agent,
        channelId: _channel,
        sdpOffer: 'v=0 offer',
        clientTapAt: '2026-10-23T12:00:00.000Z',
        systemCallUI: 'callkit',
      );
      expect(started.callId, _call);
      expect(
        sent!.url.toString(),
        'https://api.example.com/api/buzz-voice/ios/calls',
      );
      expect(sent!.headers['X-Buzz-Community'], 'chat.example.com');
      final body = jsonDecode(sent!.body) as Map<String, Object?>;
      expect(body['agentPubkey'], _agent);
      expect(body['channelId'], _channel);
      expect(body['clientDiagnostics'], {'systemCallUI': 'callkit'});
      final event =
          jsonDecode(
                utf8.decode(
                  base64.decode(
                    sent!.headers['Authorization']!.substring('Nostr '.length),
                  ),
                ),
              )
              as Map<String, Object?>;
      final tags = (event['tags'] as List).cast<List<Object?>>();
      expect(
        tags.firstWhere((tag) => tag.first == 'payload')[1],
        sha256.convert(sent!.bodyBytes).toString(),
      );
      expect(
        tags.firstWhere((tag) => tag.first == 'u')[1],
        'https://api.example.com/api/buzz-voice/ios/calls',
      );
    });

    test('host refusals become plain sentences', () async {
      final api = AgentCallApi(
        origin: 'https://api.example.com',
        communityId: 'chat.example.com',
        nsec: nostr.Keys.generate().nsec,
        httpClient: MockClient(
          (_) async => http.Response('{"error":"voice_buzz_dm_required"}', 409),
        ),
      );
      await expectLater(
        api.start(
          agentPubkey: _agent,
          channelId: _channel,
          sdpOffer: 'v',
          clientTapAt: 'x',
          systemCallUI: 'callkit',
        ),
        throwsA(
          isA<AgentCallApiException>()
              .having((e) => e.status, 'status', 409)
              .having((e) => e.code, 'code', 'voice_buzz_dm_required'),
        ),
      );
      expect(
        describeAgentCallError(
          const AgentCallApiException(409, 'voice_buzz_dm_required'),
        ),
        contains('private DM'),
      );
    });

    test('the origin is the guest route host', () {
      expect(
        agentCallOrigin(
          const GuestAccessRoute(
            baseUrl: 'https://api.example.com/api/buzz-guest/v1',
            communityId: 'chat.example.com',
          ),
        ),
        'https://api.example.com',
      );
    });
  });

  group('AgentCallFeed', () {
    test('orders pinned asks first and keeps archived apart', () {
      Map<String, Object?> ask(
        String key, {
        String? pinnedAt,
        String? archivedAt,
      }) => {
        'utteranceId': key,
        'kind': 'ask',
        'text': 'do $key',
        'status': 'submitted',
        'pinnedAt': pinnedAt,
        'archivedAt': archivedAt,
        'links': const [],
      };
      final feed = AgentCallFeed.tryParse(
        _feed(
          asks: [
            ask('a'),
            ask('b', pinnedAt: '2026-10-23T12:01:00Z'),
            ask('c', archivedAt: '2026-10-23T12:02:00Z'),
            ask('d', pinnedAt: '2026-10-23T12:03:00Z'),
          ],
        ),
      )!;
      expect(feed.shownAsks.map((ask) => ask.askKey), ['d', 'b', 'a']);
      expect(feed.archivedCount, 1);
      expect(feed.anyWorking, isTrue);
    });

    test('opens only https links and waits for the recap after the call', () {
      final ended = AgentCallFeed.tryParse({
        ..._feed(
          state: 'ended',
          asks: [
            {
              'utteranceId': 'a',
              'kind': 'ask',
              'text': 'x',
              'status': 'answered',
              'links': [
                {'url': 'https://example.com/deck', 'title': 'Deck'},
                {'url': 'javascript:alert(1)', 'title': 'Bad'},
              ],
            },
          ],
        ),
        'contract': 2,
        'recap': {'summary': null},
      })!;
      expect(ended.asks.single.links.map((link) => link.url), [
        'https://example.com/deck',
      ]);
      expect(ended.wantsMore, isTrue);
      final written = AgentCallFeed.tryParse({
        ..._feed(state: 'ended'),
        'contract': 2,
        'recap': {'summary': '- Sent'},
      })!;
      expect(written.wantsMore, isFalse);
    });
  });

  group('AgentCallNotifier', () {
    late _FakeMedia media;
    late List<http.Request> requests;
    late ProviderContainer container;
    late http.Client client;

    ProviderContainer build(List<Override> overrides) {
      final built = ProviderContainer(
        overrides: [
          agentCallMediaProvider.overrideWithValue(media),
          agentCallApiProvider.overrideWithValue(
            AgentCallApi(
              origin: 'https://api.example.com',
              communityId: 'chat.example.com',
              nsec: nostr.Keys.generate().nsec,
              httpClient: client,
            ),
          ),
          ...overrides,
        ],
      );
      addTearDown(built.dispose);
      return built;
    }

    setUp(() {
      media = _FakeMedia();
      requests = [];
      client = MockClient((request) async {
        requests.add(request);
        if (request.url.path.endsWith('/calls')) {
          return http.Response(
            jsonEncode({
              'callId': _call,
              'sdpAnswer': 'v=0 answer',
              'executeUntil': null,
            }),
            201,
          );
        }
        if (request.url.path.endsWith('/feed')) {
          if (request.url.queryParameters['rev'] == 'r1') {
            // A long-poll with nothing new.
            await Future<void>.delayed(const Duration(milliseconds: 50));
            return http.Response('{"rev":"r1","unchanged":true}', 200);
          }
          return http.Response(jsonEncode(_feed()), 200);
        }
        return http.Response('{}', 200);
      });
      container = ProviderContainer(
        overrides: [
          agentCallMediaProvider.overrideWithValue(media),
          agentCallHuddleBusyProvider.overrideWithValue(false),
          agentCallApiProvider.overrideWithValue(
            AgentCallApi(
              origin: 'https://api.example.com',
              communityId: 'chat.example.com',
              nsec: nostr.Keys.generate().nsec,
              httpClient: client,
            ),
          ),
        ],
      );
    });

    tearDown(() => container.dispose());

    test(
      'a call connects, follows the feed and hangs up without stopping work',
      () async {
        final notifier = container.read(agentCallProvider.notifier);
        await notifier.start(
          agentPubkey: _agent,
          channelId: _channel,
          agentName: 'Alfred',
        );
        expect(media.calls, ['begin:Alfred']);
        expect(media.answer, 'v=0 answer');
        media.events$.add(
          const AgentCallMediaEventData(AgentCallMediaEvent.connected),
        );
        await Future<void>.delayed(const Duration(milliseconds: 10));
        expect(container.read(agentCallProvider).phase, AgentCallPhase.live);
        expect(container.read(agentCallProvider).feed?.callId, _call);

        await notifier.hangUp();
        final state = container.read(agentCallProvider);
        expect(state.phase, AgentCallPhase.ended);
        expect(media.calls, contains('end'));
        final paths = requests.map((request) => request.url.path).toList();
        expect(paths, contains('/api/buzz-voice/ios/calls/$_call/end'));
        expect(paths.where((path) => path.endsWith('/stop')), isEmpty);
        notifier.dismiss();
      },
    );

    test('a huddle in progress keeps the call from starting', () async {
      final busy = ProviderContainer(
        overrides: [
          agentCallMediaProvider.overrideWithValue(media),
          agentCallHuddleBusyProvider.overrideWithValue(true),
        ],
      );
      addTearDown(busy.dispose);
      await busy
          .read(agentCallProvider.notifier)
          .start(agentPubkey: _agent, channelId: _channel, agentName: 'Alfred');
      expect(busy.read(agentCallProvider).phase, AgentCallPhase.error);
      expect(media.calls, isEmpty);
    });

    test('a Huddle start under way keeps the call from starting', () async {
      final starting = build([]);
      starting.read(huddleStartingProvider.notifier).update(true);
      await starting
          .read(agentCallProvider.notifier)
          .start(agentPubkey: _agent, channelId: _channel, agentName: 'Alfred');
      expect(starting.read(agentCallProvider).phase, AgentCallPhase.error);
      expect(media.calls, isEmpty);
      expect(requests, isEmpty);
    });

    test('a Huddle that joins while the call is set up refuses it', () async {
      final busy = build([
        agentCallHuddleBusyProvider.overrideWith(
          (ref) => ref.watch(_huddleInSession),
        ),
      ]);
      media.onBegin = () => busy.read(_huddleInSession.notifier).raise();
      await busy
          .read(agentCallProvider.notifier)
          .start(agentPubkey: _agent, channelId: _channel, agentName: 'Alfred');
      expect(busy.read(agentCallProvider).phase, AgentCallPhase.error);
      expect(media.calls, ['begin:Alfred', 'end']);
      expect(requests, isEmpty);
      expect(busy.read(agentCallAudioBusyProvider), isFalse);
    });

    test('a busy call refuses Huddle joins until it ends', () async {
      var huddleMedia = 0;
      final both = build([
        agentCallHuddleBusyProvider.overrideWithValue(false),
        huddleMediaFactoryProvider.overrideWithValue(() {
          huddleMedia++;
          throw StateError('no Huddle media in this test');
        }),
      ]);
      final notifier = both.read(agentCallProvider.notifier);
      await notifier.start(
        agentPubkey: _agent,
        channelId: _channel,
        agentName: 'Alfred',
      );
      expect(both.read(agentCallAudioBusyProvider), isTrue);

      await both
          .read(huddleSessionProvider.notifier)
          .join(
            HuddleConnectionParameters(
              relayWebSocketUrl: 'wss://buzz.example',
              nsec:
                  '09b3065e3570a3a4054660dccd66e12774a99a904fdb0ca02dbc6c3136249506',
              parentChannelId: '11111111-2222-4333-8444-555555555555',
              ephemeralChannelId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            ),
          );
      final huddle = both.read(huddleSessionProvider);
      expect(huddle.phase, HuddleSessionPhase.failed);
      expect(huddle.error, agentCallHuddleRefusal);
      expect(huddleMedia, 0);
      expect(both.read(agentCallProvider).isBusy, isTrue);

      await notifier.hangUp();
      expect(both.read(agentCallAudioBusyProvider), isFalse);
      notifier.dismiss();
    });

    test(
      'a call still connecting after the timeout ends as media_failed',
      () async {
        final timed = build([
          agentCallHuddleBusyProvider.overrideWithValue(false),
          agentCallConnectTimeoutProvider.overrideWithValue(
            const Duration(milliseconds: 20),
          ),
        ]);
        await timed
            .read(agentCallProvider.notifier)
            .start(
              agentPubkey: _agent,
              channelId: _channel,
              agentName: 'Alfred',
            );
        expect(timed.read(agentCallProvider).phase, AgentCallPhase.connecting);
        await Future<void>.delayed(const Duration(milliseconds: 80));
        expect(timed.read(agentCallProvider).phase, AgentCallPhase.error);
        expect(media.calls, contains('end'));
        final end = requests.firstWhere(
          (request) => request.url.path.endsWith('/end'),
        );
        expect(jsonDecode(end.body), {'reason': 'media_failed'});
        expect(timed.read(agentCallAudioBusyProvider), isFalse);
      },
    );

    test('feed retries back off from 1 s to 15 s', () {
      expect(agentCallFeedRetryDelay(1), const Duration(seconds: 1));
      expect(agentCallFeedRetryDelay(3), const Duration(seconds: 4));
      expect(agentCallFeedRetryDelay(9), const Duration(seconds: 15));
    });
  });

  group('AgentCallApi response cap', () {
    AgentCallApi api(http.Client client) => AgentCallApi(
      origin: 'https://api.example.com',
      communityId: 'chat.example.com',
      nsec: nostr.Keys.generate().nsec,
      httpClient: client,
    );

    test('a declared oversize answer is refused before reading', () async {
      final client = MockClient.streaming(
        (_, _) async => http.StreamedResponse(
          const Stream.empty(),
          200,
          contentLength: guestAccessMaxResponseBytes + 1,
        ),
      );
      await expectLater(
        api(client).end(_call, 'hangup'),
        throwsA(
          isA<AgentCallApiException>().having(
            (e) => e.code,
            'code',
            'response_too_large',
          ),
        ),
      );
    });

    test('an undeclared oversize answer stops being read at the cap', () async {
      final chunk = List<int>.filled(512 * 1024, 32);
      final client = MockClient.streaming(
        (_, _) async => http.StreamedResponse(
          Stream.fromIterable(List.filled(5, chunk)),
          200,
        ),
      );
      await expectLater(
        api(client).end(_call, 'hangup'),
        throwsA(
          isA<AgentCallApiException>().having(
            (e) => e.code,
            'code',
            'response_too_large',
          ),
        ),
      );
    });
  });

  group('AgentCallButton', () {
    Future<void> pump(WidgetTester tester) => tester.pumpWidget(
      ProviderScope(
        overrides: [agentCallMediaProvider.overrideWithValue(_FakeMedia())],
        child: MaterialApp(
          home: Scaffold(
            body: AgentCallButton(
              agentPubkey: _agent,
              channelId: _channel,
              agentName: 'Alfred',
            ),
          ),
        ),
      ),
    );

    testWidgets('shows on iOS', (tester) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
      addTearDown(() => debugDefaultTargetPlatformOverride = null);
      await pump(tester);
      expect(find.byKey(const ValueKey('agent-call-button')), findsOneWidget);
      debugDefaultTargetPlatformOverride = null;
    });

    testWidgets('is hidden on Android', (tester) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.android;
      addTearDown(() => debugDefaultTargetPlatformOverride = null);
      await pump(tester);
      expect(find.byKey(const ValueKey('agent-call-button')), findsNothing);
      debugDefaultTargetPlatformOverride = null;
    });
  });
}
