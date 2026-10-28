import 'dart:async';
import 'dart:convert';

import 'package:buzz/features/agent_call/agent_call_api.dart';
import 'package:buzz/features/agent_call/agent_call_controller.dart';
import 'package:buzz/features/agent_call/agent_call_media.dart';
import 'package:buzz/features/agent_call/voice_provider.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:nostr/nostr.dart' as nostr;

const _call = '0192a6b0-0000-7000-8000-0000000000ac';
const _channel = '0192a6b0-0000-7000-8000-0000000000af';
const _agentId = '0192a6b0-0000-7000-8000-0000000000ab';
final _agent = 'b' * 64;

Map<String, Object?> _settings({
  String effective = 'gemini',
  String? userDefault = 'gemini',
}) => {
  'data': {
    'providers': [
      {'id': 'gpt-live', 'label': 'GPT-Live', 'available': true},
      {
        'id': 'gemini',
        'label': 'Gemini',
        'available': false,
        'unavailableReason': 'no_credential',
      },
      {'id': 'someday', 'label': 'Someday', 'available': true},
    ],
    'systemDefault': 'gpt-live',
    'userDefault': userDefault,
    'agentOverrides': [
      {'agentId': _agentId, 'provider': 'gpt-live'},
    ],
    'revision': 3,
    'effective': {
      'agentId': _agentId,
      'provider': effective,
      'source': 'user',
      'available': true,
      'fallbackFrom': null,
      'fallbackReason': null,
      'revision': 2,
    },
  },
};

class _FakeMedia implements AgentCallMedia {
  final events$ = StreamController<AgentCallMediaEventData>.broadcast();
  final calls = <String>[];

  @override
  Stream<AgentCallMediaEventData> get events => events$.stream;

  @override
  Future<AgentCallOffer> begin({required String agentName}) async {
    calls.add('begin');
    return const AgentCallOffer(sdp: 'v=0 offer', systemCallUI: 'callkit');
  }

  @override
  Future<void> accept(String sdpAnswer) async => calls.add('accept');

  @override
  Future<void> setMuted(bool muted) async {}

  @override
  Future<void> end() async => calls.add('end');
}

AgentCallApi _api(MockClient client) => AgentCallApi(
  origin: 'https://api.example.com',
  communityId: 'chat.example.com',
  nsec: nostr.Keys.generate().nsec,
  httpClient: client,
);

void main() {
  group('voice settings', () {
    test('reads only known providers, with reasons and revisions', () {
      final settings = VoiceSettings.tryParse(_settings())!;
      expect(settings.providers.map((option) => option.id), [
        VoiceProviderId.gptLive,
        VoiceProviderId.gemini,
      ]);
      expect(settings.providers[1].available, isFalse);
      expect(settings.providers[1].unavailableReason, 'no_credential');
      expect(settings.userDefault, VoiceProviderId.gemini);
      expect(settings.revision, 3);
      expect(settings.effective?.revision, 2);
      expect(
        settings.overrideFor(_agentId.toUpperCase()),
        VoiceProviderId.gptLive,
      );
      expect(VoiceSettings.tryParse({'data': {}}), isNull);
    });

    test('the line says the voice only for Gemini or a fallback', () {
      expect(
        voiceProviderLine(
          const VoiceStartProvider(id: VoiceProviderId.gptLive),
        ),
        isNull,
      );
      expect(
        voiceProviderLine(const VoiceStartProvider(id: VoiceProviderId.gemini)),
        'Voice: Gemini',
      );
      expect(
        voiceProviderLine(
          const VoiceStartProvider(
            id: VoiceProviderId.gptLive,
            fallbackFrom: VoiceProviderId.gemini,
          ),
        ),
        'Voice: GPT-Live (Gemini unavailable)',
      );
    });
  });

  group('AgentCallApi voice routes', () {
    test('reads settings by agent key and writes with revisions', () async {
      final sent = <http.Request>[];
      final api = _api(
        MockClient((request) async {
          sent.add(request);
          return http.Response(jsonEncode(_settings()), 200);
        }),
      );
      expect(await api.voiceSettings(_agent), isNotNull);
      await api.setVoiceOverride(_agentId, null, 2);
      await api.setVoiceDefault(VoiceProviderId.gemini, 3);
      expect(
        sent[0].url.toString(),
        'https://api.example.com/api/buzz-voice/ios/settings?agentPubkey=$_agent',
      );
      expect(sent[1].method, 'PUT');
      expect(sent[1].url.path, '/api/buzz-voice/ios/settings/agents/$_agentId');
      expect(jsonDecode(sent[1].body), {
        'provider': null,
        'expectedRevision': 2,
      });
      expect(jsonDecode(sent[2].body), {
        'defaultProvider': 'gemini',
        'expectedRevision': 3,
      });
    });

    test('a host without the settings read has no chooser', () async {
      final api = _api(MockClient((_) async => http.Response('nope', 404)));
      expect(await api.voiceSettings(_agent), isNull);
    });

    test('a plain tap sends no provider; a pick sends it', () async {
      final bodies = <Map<String, Object?>>[];
      final api = _api(
        MockClient((request) async {
          bodies.add(jsonDecode(request.body) as Map<String, Object?>);
          return http.Response(
            jsonEncode({
              'callId': _call,
              'sdpAnswer': 'v=0 answer',
              'provider': {'id': 'gpt-live', 'source': 'call'},
            }),
            201,
          );
        }),
      );
      Future<AgentCallStart> start(VoiceProviderId? provider) => api.start(
        agentPubkey: _agent,
        channelId: _channel,
        sdpOffer: 'v=0 offer',
        clientTapAt: '2026-10-28T12:00:00.000Z',
        systemCallUI: 'callkit',
        provider: provider,
      );
      await start(null);
      final picked = await start(VoiceProviderId.gptLive);
      expect(bodies[0].containsKey('provider'), isFalse);
      expect(bodies[1]['provider'], 'gpt-live');
      expect(picked.provider?.id, VoiceProviderId.gptLive);
    });

    test('an unavailable pick keeps its reason and reads as one', () async {
      final api = _api(
        MockClient(
          (_) async => http.Response(
            jsonEncode({
              'error': 'voice_provider_unavailable',
              'details': {'provider': 'gemini', 'reason': 'no_credential'},
            }),
            409,
          ),
        ),
      );
      final error = await api
          .start(
            agentPubkey: _agent,
            channelId: _channel,
            sdpOffer: 'v=0 offer',
            clientTapAt: '2026-10-28T12:00:00.000Z',
            systemCallUI: 'callkit',
            provider: VoiceProviderId.gemini,
          )
          .then<Object?>((_) => null, onError: (Object error) => error);
      expect(isVoiceProviderUnavailable(error!), isTrue);
      expect(
        describeAgentCallError(error),
        'Gemini needs a Google Cloud Gemini key for your organization.',
      );
    });
  });

  group('AgentCallNotifier voice', () {
    late _FakeMedia media;
    late ProviderContainer container;
    late List<Map<String, Object?>> starts;
    late http.Response Function() startAnswer;

    setUp(() {
      media = _FakeMedia();
      starts = [];
      startAnswer = () => http.Response(
        jsonEncode({'callId': _call, 'sdpAnswer': 'v=0 answer'}),
        201,
      );
      final client = MockClient((request) async {
        if (request.url.path.endsWith('/calls')) {
          starts.add(jsonDecode(request.body) as Map<String, Object?>);
          return startAnswer();
        }
        if (request.url.path.endsWith('/feed')) {
          await Future<void>.delayed(const Duration(milliseconds: 50));
          return http.Response('{"rev":"r1","unchanged":true}', 200);
        }
        return http.Response('{}', 200);
      });
      container = ProviderContainer(
        overrides: [
          agentCallMediaProvider.overrideWithValue(media),
          agentCallHuddleBusyProvider.overrideWithValue(false),
          agentCallApiProvider.overrideWithValue(_api(client)),
        ],
      );
    });

    tearDown(() => container.dispose());

    test('an inherited Gemini choice this app cannot run says so', () async {
      await container
          .read(agentCallProvider.notifier)
          .start(
            agentPubkey: _agent,
            channelId: _channel,
            agentName: 'Alfred',
            expectedProvider: VoiceProviderId.gemini,
          );
      expect(starts.single.containsKey('provider'), isFalse);
      expect(
        voiceProviderLine(container.read(agentCallProvider).voice),
        'Voice: GPT-Live (Gemini unavailable)',
      );
    });

    test("the host's own provider wins over the settings read", () async {
      startAnswer = () => http.Response(
        jsonEncode({
          'callId': _call,
          'sdpAnswer': 'v=0 answer',
          'provider': {
            'id': 'gpt-live',
            'fallbackFrom': 'gemini',
            'fallbackReason': 'model_grant_missing',
          },
        }),
        201,
      );
      await container
          .read(agentCallProvider.notifier)
          .start(
            agentPubkey: _agent,
            channelId: _channel,
            agentName: 'Alfred',
            expectedProvider: VoiceProviderId.gemini,
          );
      expect(
        container.read(agentCallProvider).voice?.fallbackReason,
        'model_grant_missing',
      );
    });

    test(
      'a failed Gemini pick offers GPT-Live, which retries as GPT-Live',
      () async {
        startAnswer = () => http.Response(
          jsonEncode({
            'error': 'voice_transport_unsupported',
            'details': {'provider': 'gemini', 'transport': 'gemini_ws'},
          }),
          400,
        );
        final notifier = container.read(agentCallProvider.notifier);
        await notifier.start(
          agentPubkey: _agent,
          channelId: _channel,
          agentName: 'Alfred',
          provider: VoiceProviderId.gemini,
        );
        var state = container.read(agentCallProvider);
        expect(state.phase, AgentCallPhase.error);
        expect(state.offersGptLive, isTrue);
        // The microphone closes on the failed start.
        expect(media.calls, ['begin', 'end']);

        startAnswer = () => http.Response(
          jsonEncode({'callId': _call, 'sdpAnswer': 'v=0 answer'}),
          201,
        );
        await notifier.retryWithGptLive();
        state = container.read(agentCallProvider);
        expect(starts.last['provider'], 'gpt-live');
        expect(state.phase, AgentCallPhase.connecting);
        expect(state.offersGptLive, isFalse);
      },
    );

    test('other failures offer no voice change', () async {
      startAnswer = () =>
          http.Response('{"error":"voice_buzz_dm_required"}', 409);
      await container
          .read(agentCallProvider.notifier)
          .start(
            agentPubkey: _agent,
            channelId: _channel,
            agentName: 'Alfred',
            provider: VoiceProviderId.gemini,
          );
      expect(container.read(agentCallProvider).offersGptLive, isFalse);
    });
  });
}
