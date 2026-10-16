import 'dart:convert';

import 'package:buzz/shared/guest_access/guest_access_client.dart';
import 'package:buzz/shared/guest_access/guest_approval.dart';
import 'package:buzz/shared/guest_access/guest_owner_copy.dart';
import 'package:buzz/shared/guest_access/guest_owner_records.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:nostr/nostr.dart' as nostr;

final _ownerNsec = nostr.Nip19.encode(
  prefix: nostr.Nip19Prefix.nsec,
  data: '0000000000000000000000000000000000000000000000000000000000000001',
);

const _route = GuestAccessRoute(
  baseUrl: 'https://api.example.com/guest/v1',
  communityId: 'chat.example.com',
);

typedef _Call = ({String method, String path, Map<String, String> query});

GuestAccessClient _client(
  List<_Call> calls,
  List<Map<String, Object?>?> bodies, {
  Object? response,
  int status = 200,
}) => GuestAccessClient(
  route: _route,
  nsec: _ownerNsec,
  httpClient: MockClient((request) async {
    expect(request.headers['X-Buzz-Community'], 'chat.example.com');
    expect(request.headers['Authorization'], startsWith('Nostr '));
    calls.add((
      method: request.method,
      path: request.url.path,
      query: request.url.queryParameters,
    ));
    bodies.add(
      request.body.isEmpty
          ? null
          : jsonDecode(request.body) as Map<String, Object?>,
    );
    return http.Response(jsonEncode(response ?? {'ok': true}), status);
  }),
);

void main() {
  group('owner record readers', () {
    test('agents read the agents envelope and lowercase pubkeys', () {
      final agents = parseOwnerAgents({
        'agents': [
          {
            'guest_endpoint_id': 'ep-1',
            'pubkey': 'A' * 64,
            'display_name': 'Atlas',
            'enabled': false,
            'respond_to': 'anyone',
            'last_seen_at': '2026-10-16T10:00:00.000Z',
          },
          {'guest_endpoint_id': 'ep-2'},
          'junk',
        ],
      });
      expect(agents, hasLength(1));
      expect(agents.single.pubkey, 'a' * 64);
      expect(agents.single.enabled, isFalse);
      expect(agents.single.respondTo, 'anyone');
    });

    test('grants tolerate missing fields and unknown scopes', () {
      final grants = parseGrantList({
        'items': [
          {
            'grant_id': 'g-1',
            'guest_endpoint_id': 'ep-1',
            'grantee': {'user_id': 'u-1', 'display_name': 'Jess'},
            'scope': 'person_days',
            'data_sources': ['calendar_events', 7],
            'expires_at': '2026-10-20T00:00:00.000Z',
            'use_count': 3,
          },
          {'grant_id': 'g-2', 'scope': 'forever'},
          {'scope': 'always'},
        ],
      });
      expect(grants.map((grant) => grant.grantId), ['g-1', 'g-2']);
      expect(grants.first.scope, GrantScope.personDays);
      expect(grants.first.dataSources, ['calendar_events']);
      expect(grants.first.useCount, 3);
      expect(grants.last.scope, GrantScope.once);
      expect(grants.last.useCount, 0);
    });

    test('active grants drop revoked and expired ones', () {
      final now = DateTime.utc(2026, 10, 16);
      final grants = parseGrantList([
        {'grant_id': 'live', 'guest_endpoint_id': 'ep-1'},
        {
          'grant_id': 'expired',
          'guest_endpoint_id': 'ep-1',
          'expires_at': '2026-10-15T00:00:00.000Z',
        },
        {
          'grant_id': 'revoked',
          'guest_endpoint_id': 'ep-1',
          'revoked_at': '2026-10-14T00:00:00.000Z',
        },
        {'grant_id': 'other', 'guest_endpoint_id': 'ep-2'},
      ]);
      expect(activeGrants(grants, now: now).map((grant) => grant.grantId), [
        'live',
        'other',
      ]);
      expect(
        activeGrants(
          grants,
          guestEndpointId: 'ep-1',
          now: now,
        ).map((grant) => grant.grantId),
        ['live'],
      );
    });

    test('blocks need an id and a pubkey', () {
      final blocks = parseBlockList({
        'items': [
          {
            'block_id': 'b-1',
            'guest_endpoint_id': null,
            'pubkey': 'B' * 64,
            'reason': 'spam',
          },
          {'block_id': 'b-2'},
        ],
      });
      expect(blocks, hasLength(1));
      expect(blocks.single.guestEndpointId, isNull);
      expect(blocks.single.pubkey, 'b' * 64);
      expect(blocks.single.reason, 'spam');
    });

    test('access log reads entries, classifier and the next cursor', () {
      final page = parseAccessLog({
        'items': [
          {
            'entry_id': 'e-1',
            'at': '2026-10-16T09:00:00.000Z',
            'guest_endpoint_id': 'ep-1',
            'requester': {'pubkey': 'c' * 64, 'linked': true},
            'tier': 2,
            'outcome': 'held',
            'data_sources': ['memory'],
            'classifier': {
              'route': 'escalate',
              'severity': 'high',
              'categories': ['pressure'],
            },
            'question_text': 'What is the pricing?',
          },
          {'outcome': 'answered'},
        ],
        'next_cursor': '2026-10-16T09:00:00.000Z',
      });
      expect(page.items, hasLength(1));
      final entry = page.items.single;
      expect(entry.tier, 2);
      expect(entry.requester.linked, isTrue);
      expect(entry.classifier.categories, ['pressure']);
      expect(entry.questionText, 'What is the pricing?');
      expect(page.nextCursor, '2026-10-16T09:00:00.000Z');
      expect(classifierLine(entry.classifier), 'Safety check: escalate (high)');
    });

    test('digest reads counts and skips requesters without a key', () {
      final digest = parseDigest({
        'date': '2026-10-15',
        'total': 4,
        'by_outcome': {'answered': 3, 'held': 1, 'bad': 'x'},
        'by_requester': [
          {'pubkey': 'd' * 64, 'display_name': 'Jess', 'count': 4},
          {'count': 1},
        ],
        'flagged_requests': 1,
        'pending_approvals': 0,
        'open_suggestions': 2,
      });
      expect(digest.byOutcome, {'answered': 3, 'held': 1});
      expect(digest.byRequester, hasLength(1));
      expect(digest.isQuiet, isFalse);
      expect(parseDigest(null).isQuiet, isTrue);
    });

    test('shareables and suggestions', () {
      final shared = parseShareableList([
        {'shareable_id': 's-1', 'resource_kind': 'status', 'content': 'Away'},
        {'content': 'no id'},
      ]);
      expect(shared.single.resourceKind, 'status');
      final suggestions = parseSuggestionList({
        'items': [
          {
            'suggestion_id': 'sg-1',
            'grantee': {'display_name': 'Jess'},
            'question_kind': 'pipeline_status',
            'approvals_count': 3,
            'proposed_scope': 'always',
          },
        ],
      });
      expect(
        suggestionQuestion(suggestions.single),
        'Always allow Jess on pipeline status?',
      );
      expect(
        suggestionDetail(suggestions.single),
        'You approved 3 similar requests.',
      );
    });

    test('admin overview reads alerts and suspended requesters', () {
      final overview = parseAdminOverview({
        'alerts': [
          {
            'alert_id': 'a-1',
            'kind': 'org_pattern',
            'severity': 'high',
            'payload': {
              'pattern': 'flagged_across_owners',
              'requester_public_key': 'e' * 64,
              'owners': 4,
            },
          },
          {'alert_id': 'a-2'},
        ],
        'suspended_requesters': [
          {'pubkey': 'f' * 64, 'reason': 'two_high_flags_24h'},
        ],
      });
      expect(overview.alerts, hasLength(1));
      expect(overview.alerts.single.count, 4);
      expect(
        adminAlertText(overview.alerts.single, 'Sam'),
        "Sam sent flagged requests to 4 different people's agents in 24 hours.",
      );
      expect(
        suspensionReasonText(overview.suspended.single.reason!),
        'Two high-risk requests within 24 hours',
      );
    });
  });

  group('wording', () {
    test('outcomes, tiers and access modes', () {
      expect(outcomeLabel('held'), 'Waiting for you');
      expect(outcomeLabel('new_outcome'), 'New outcome');
      expect(outcomeTone('blocked'), GuestTone.danger);
      expect(outcomeTone('answered'), GuestTone.positive);
      expect(tierLabel(1), 'Shared info');
      expect(tierLabel(3), isNull);
      expect(respondToSummary('owner-only'), startsWith('Only you'));
    });

    test('relative times and digest days', () {
      final now = DateTime.utc(2026, 10, 16, 12);
      expect(formatRelative(null), 'never');
      expect(formatRelative('2026-10-16T11:55:00.000Z', now: now), '5 min ago');
      expect(formatRelative('2026-10-16T09:00:00.000Z', now: now), '3 h ago');
      expect(
        formatRelative('2026-10-12T12:00:00.000Z', now: now),
        '4 days ago',
      );
      expect(defaultDigestDate(now: now), '2026-10-15');
      expect(formatDigestDay('2026-10-15'), 'Oct 15, 2026');
    });
  });

  group('owner client', () {
    test('reads use the owner routes and query parameters', () async {
      final calls = <_Call>[];
      final bodies = <Map<String, Object?>?>[];
      final client = _client(calls, bodies, response: {'items': []});
      await client.grants();
      await client.blocks();
      await client.accessLog(guestEndpointId: 'ep-1', cursor: 'c-1');
      await client.digest('2026-10-15');
      await client.shareables();
      await client.suggestions();
      expect(calls.map((call) => '${call.method} ${call.path}'), [
        'GET /guest/v1/owner/grants',
        'GET /guest/v1/owner/blocks',
        'GET /guest/v1/owner/access-log',
        'GET /guest/v1/owner/digest',
        'GET /guest/v1/owner/shareables',
        'GET /guest/v1/owner/suggestions',
      ]);
      expect(calls[2].query, {'agent': 'ep-1', 'cursor': 'c-1', 'limit': '50'});
      expect(calls[3].query, {'date': '2026-10-15'});
    });

    test('changes send the desktop request bodies', () async {
      final calls = <_Call>[];
      final bodies = <Map<String, Object?>?>[];
      final client = _client(calls, bodies);
      await client.setAgentEnabled('ep-1', false);
      await client.revokeGrant('g-1');
      await client.block(pubkey: 'A' * 64);
      await client.unblock('b-1');
      await client.addShareable(
        resourceKind: 'note',
        content: 'Launch moved',
        expiresInDays: 7,
      );
      await client.removeShareable('s-1');
      await client.decideSuggestion('sg-1', accept: true);
      await client.decideSuggestion('sg-2', accept: false);
      await client.acknowledgeAdminAlert('a-1');
      await client.restoreRequester('F' * 64);
      expect(calls.map((call) => '${call.method} ${call.path}'), [
        'PATCH /guest/v1/owner/agents/ep-1',
        'DELETE /guest/v1/owner/grants/g-1',
        'POST /guest/v1/owner/blocks',
        'DELETE /guest/v1/owner/blocks/b-1',
        'POST /guest/v1/owner/shareables',
        'DELETE /guest/v1/owner/shareables/s-1',
        'POST /guest/v1/owner/suggestions/sg-1/accept',
        'POST /guest/v1/owner/suggestions/sg-2/dismiss',
        'POST /guest/v1/admin/alerts/a-1/ack',
        'POST /guest/v1/admin/requesters/${'f' * 64}/review',
      ]);
      expect(bodies[0], {'enabled': false});
      expect(bodies[1], isNull);
      expect(bodies[2], {'guest_endpoint_id': null, 'pubkey': 'a' * 64});
      expect(bodies[4], {
        'resource_kind': 'note',
        'content': 'Launch moved',
        'expires_in_days': 7,
      });
      expect(bodies[6], <String, Object?>{});
    });

    test('a non-admin gets admin_required', () async {
      final client = _client(
        [],
        [],
        response: {'error': 'admin_required'},
        status: 403,
      );
      await expectLater(
        client.adminOverview(),
        throwsA(
          isA<GuestAccessException>().having(
            (error) => isAdminRequired(error),
            'isAdminRequired',
            isTrue,
          ),
        ),
      );
    });
  });
}
