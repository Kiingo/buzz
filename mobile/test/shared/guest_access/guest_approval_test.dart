import 'dart:convert';

import 'package:buzz/shared/guest_access/guest_access_client.dart';
import 'package:buzz/shared/guest_access/guest_approval.dart';
import 'package:buzz/shared/guest_access/guest_approval_decision.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:nostr/nostr.dart' as nostr;

final _ownerNsec = nostr.Nip19.encode(
  prefix: nostr.Nip19Prefix.nsec,
  data: '0000000000000000000000000000000000000000000000000000000000000001',
);

Map<String, Object?> _approvalJson({
  Map<String, Object?> requester = const {},
  List<String> reasonCodes = const [],
  Object? requestedSources,
  Object? requestableSources,
  Map<String, Object?>? preview,
  String state = 'pending',
}) => {
  'approval_id': 'appr-1',
  'agent': {'pubkey': 'a' * 64, 'display_name': 'Atlas'},
  'guest_turn_id': 'turn-1',
  'requester': {'pubkey': 'b' * 64, 'display_name': 'Jess', ...requester},
  'question_text': 'When is Ross free?',
  'draft_text': 'Let me check with Ross.',
  'reason_codes': reasonCodes,
  'requested_sources': ?requestedSources,
  'requestable_sources': ?requestableSources,
  'channel': {'type': 'dm'},
  'state': state,
  'preview': ?preview,
};

void main() {
  group('parseGuestApproval', () {
    test('reads requester context and tolerates missing fields', () {
      final approval = parseGuestApproval(
        _approvalJson(
          requester: {
            'kind': 'colleague',
            'linked': true,
            'linked_at': '2026-10-01T00:00:00Z',
            'prior_request_count': 2,
          },
        ),
      )!;
      expect(approval.requester.kind, RequesterKind.colleague);
      expect(approval.requester.isTest, isFalse);
      expect(approval.requester.priorRequestCount, 2);
      expect(approval.agentDisplayName, 'Atlas');
      expect(approval.channel.type, 'dm');
      expect(approval.preview, isNull);
      expect(parseGuestApproval({'agent': {}}), isNull);
    });

    test('kind test or is_test marks a TEST requester', () {
      expect(
        parseGuestApproval(
          _approvalJson(requester: {'is_test': true}),
        )!.requester.isTest,
        isTrue,
      );
      expect(
        parseGuestApproval(
          _approvalJson(requester: {'kind': 'test'}),
        )!.requester.isTest,
        isTrue,
      );
      expect(
        requesterKindBadge(
          parseGuestApproval(
            _approvalJson(requester: {'kind': 'test'}),
          )!.requester,
        ),
        isNull,
      );
    });
  });

  group('wording', () {
    test('request count and linked-ago labels', () {
      expect(requestCountLabel(0), 'First request');
      expect(requestCountLabel(2), '3rd request');
      expect(requestCountLabel(10), '11th request');
      final now = DateTime.utc(2026, 10, 16);
      expect(
        linkedAgoLabel('2026-10-13T00:00:00Z', now: now),
        'linked 3 days ago',
      );
      expect(linkedAgoLabel('2026-10-16T00:00:00Z', now: now), 'linked today');
      expect(linkedAgoLabel('not a date', now: now), isNull);
    });
  });

  group('owner-data sources', () {
    test('nothing is pre-ticked when the request named no sources', () {
      final approval = parseGuestApproval(
        _approvalJson(
          reasonCodes: ['owner_data_requested'],
          requestedSources: <String>[],
        ),
      )!;
      final releasable = releasableSources(approval);
      expect(releasable.mustChoose, isTrue);
      expect(releasable.sources, defaultRequestableSources);
      expect(
        initialSharedSources(releasable.sources, releasable.mustChoose),
        isEmpty,
      );
    });

    test('named sources start checked', () {
      final approval = parseGuestApproval(
        _approvalJson(
          reasonCodes: ['owner_data_requested'],
          requestedSources: ['calendar_events'],
        ),
      )!;
      final releasable = releasableSources(approval);
      expect(releasable.mustChoose, isFalse);
      expect(initialSharedSources(releasable.sources, false), [
        'calendar_events',
      ]);
    });
  });

  group('approvalPreviewSentence', () {
    final approval = parseGuestApproval(
      _approvalJson(
        reasonCodes: ['owner_data_requested'],
        preview: {
          'agent_name': 'Atlas',
          'recipient_name': 'Jess',
          'action': 'read_and_reply',
          'destination': 'dm',
          'summary': 'Atlas will answer Jess.',
        },
      ),
    )!;

    test('follows the ticked sources and scope', () {
      expect(
        approvalPreviewSentence(
          approval,
          sharedSources: ['calendar_events'],
          grant: (scope: GrantScope.once, days: 7),
          writingReply: false,
        ),
        'Atlas will read your calendar events and reply to Jess in this DM, once.',
      );
      expect(
        approvalPreviewSentence(
          approval,
          sharedSources: const [],
          grant: (scope: GrantScope.personDays, days: 30),
          writingReply: false,
        ),
        'Choose what Atlas may read before it replies to Jess in this DM and keep answering them for 30 days without asking you.',
      );
    });

    test('writing the reply yourself', () {
      expect(
        approvalPreviewSentence(
          approval,
          sharedSources: const [],
          grant: (scope: GrantScope.once, days: 7),
          writingReply: true,
        ),
        "Your reply goes to Jess in this DM. Atlas won't read anything.",
      );
    });

    test('no preview block, no sentence', () {
      expect(
        approvalPreviewSentence(
          parseGuestApproval(_approvalJson())!,
          sharedSources: const [],
          grant: (scope: GrantScope.once, days: 7),
          writingReply: false,
        ),
        isNull,
      );
    });
  });

  group('resolveGuestAccessRoute', () {
    test('only for the community the route serves', () {
      final route = resolveGuestAccessRoute(
        routeUrl: 'https://api.example.com/guest/v1/',
        routeRelayUrl: 'https://chat.example.com',
        activeRelayUrl: 'wss://Chat.Example.com',
      );
      expect(route?.baseUrl, 'https://api.example.com/guest/v1');
      expect(route?.communityId, 'chat.example.com');
      expect(
        resolveGuestAccessRoute(
          routeUrl: 'https://api.example.com/guest/v1',
          routeRelayUrl: 'https://chat.example.com',
          activeRelayUrl: 'https://other.example.org',
        ),
        isNull,
      );
      expect(
        resolveGuestAccessRoute(
          routeUrl: '',
          routeRelayUrl: 'https://chat.example.com',
          activeRelayUrl: 'https://chat.example.com',
        ),
        isNull,
      );
    });
  });

  group('submitGuestApprovalDecision', () {
    const route = GuestAccessRoute(
      baseUrl: 'https://api.example.com/guest/v1',
      communityId: 'chat.example.com',
    );

    test('decides first, then sends the control frame', () async {
      final calls = <String>[];
      Map<String, Object?>? body;
      final client = GuestAccessClient(
        route: route,
        nsec: _ownerNsec,
        httpClient: MockClient((request) async {
          calls.add('${request.method} ${request.url.path}');
          expect(request.headers['X-Buzz-Community'], 'chat.example.com');
          expect(request.headers['Authorization'], startsWith('Nostr '));
          body = jsonDecode(request.body) as Map<String, Object?>;
          return http.Response('{}', 200);
        }),
      );
      final approval = parseGuestApproval(_approvalJson())!;
      final result = await submitGuestApprovalDecision(
        client: client,
        approval: approval,
        input: const GuestDecisionInput(
          decision: ApprovalDecision.approve,
          grant: {'scope': 'thread'},
        ),
        idempotencyKey: 'key-1',
        sendControl: (agent, payload) async {
          calls.add('control ${payload['type']} ${payload['approvalId']}');
        },
      );
      expect(result.alreadyDecided, isFalse);
      expect(calls, [
        'POST /guest/v1/owner/approvals/appr-1/decision',
        'control approve_guest_reply appr-1',
      ]);
      expect(body?['decision'], 'approve');
      expect(body?['grant'], {'scope': 'thread'});
      expect(body?['idempotency_key'], 'key-1');
    });

    test('already decided elsewhere skips the control frame', () async {
      var controls = 0;
      final client = GuestAccessClient(
        route: route,
        nsec: _ownerNsec,
        httpClient: MockClient(
          (_) async =>
              http.Response('{"error":"approval_already_decided"}', 409),
        ),
      );
      final result = await submitGuestApprovalDecision(
        client: client,
        approval: parseGuestApproval(_approvalJson())!,
        input: const GuestDecisionInput(decision: ApprovalDecision.deny),
        idempotencyKey: 'key-2',
        sendControl: (_, _) async => controls++,
      );
      expect(result.alreadyDecided, isTrue);
      expect(controls, 0);
    });

    test('a route error surfaces with its code', () async {
      final client = GuestAccessClient(
        route: route,
        nsec: _ownerNsec,
        httpClient: MockClient(
          (_) async => http.Response('{"error":"owner_not_linked"}', 403),
        ),
      );
      await expectLater(
        submitGuestApprovalDecision(
          client: client,
          approval: parseGuestApproval(_approvalJson())!,
          input: const GuestDecisionInput(decision: ApprovalDecision.deny),
          idempotencyKey: 'key-3',
        ),
        throwsA(
          isA<GuestAccessException>().having(
            (error) => error.code,
            'code',
            'owner_not_linked',
          ),
        ),
      );
    });
  });
}
