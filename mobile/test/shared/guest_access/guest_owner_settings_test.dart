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
            'question_kind': 'kiingo_files',
            'approvals_count': 3,
            'proposed_scope': 'always',
          },
        ],
      });
      expect(
        suggestionQuestion(suggestions.single),
        'Always allow Jess for questions that need your kiingo files?',
      );
      expect(
        suggestionDetail(suggestions.single),
        'You approved 3 similar requests.',
      );
    });

    test('an agent-proposed grant says who proposed it', () {
      final proposals = parseSuggestionList({
        'items': [
          {
            'suggestion_id': 'p-1',
            'source': 'agent_proposed',
            'grantee': {'display_name': 'Jess'},
            'data_sources': ['crm'],
            'approvals_count': 0,
            'proposed_scope': 'person_days',
            'days': 14,
            'proposed_by': {'via': 'agent_run', 'agent_name': 'Ada'},
          },
          {
            'suggestion_id': 'p-2',
            'source': 'agent_proposed',
            'proposed_scope': 'once',
            'proposed_by': {'via': 'mcp_client', 'agent_name': null},
          },
        ],
      });
      expect(proposals.first.agentProposed, isTrue);
      expect(
        suggestionDetail(proposals.first),
        'Ada proposed this. Nothing is shared until you allow it.',
      );
      expect(
        suggestionQuestion(proposals.first),
        startsWith('This person for 14 days: Jess on '),
      );
      expect(
        suggestionDetail(proposals.last),
        'Your MCP client proposed this. Nothing is shared until you allow it.',
      );
    });

    test('a thread proposal names its thread by the first question', () {
      final rows = parseSuggestionList({
        'items': [
          {
            'suggestion_id': 't-1',
            'source': 'agent_proposed',
            'grantee': {'display_name': 'Jess'},
            'data_sources': ['calendar_events'],
            'proposed_scope': 'thread',
            'thread_root_event_id': 'a' * 64,
            'thread_question': 'When is \u202Ethe offsite?\u200B',
          },
          {
            'suggestion_id': 't-2',
            'source': 'agent_proposed',
            'grantee': {'display_name': 'Jess'},
            'proposed_scope': 'thread',
            'thread_root_event_id': 'b' * 64,
            'thread_question': null,
          },
          {
            'suggestion_id': 't-3',
            'source': 'agent_proposed',
            'proposed_scope': 'thread',
          },
        ],
      });
      expect(rows[0].threadQuestion, 'When is the offsite?');
      // The grant sentence is fixed words; the question is never inside it.
      expect(
        suggestionQuestion(rows[0]),
        'In the thread quoted below: Jess on Calendar events?',
      );
      expect(suggestionThreadQuote(rows[0]), '“When is the offsite?”');
      expect(suggestionThreadQuote(rows[1]), isNull);
      expect(
        suggestionQuestion(rows[1]),
        startsWith('In one thread (bbbbbbbb…): Jess on '),
      );
      expect(
        suggestionQuestion(rows[2]),
        startsWith('In one thread: this person on '),
      );
    });

    test('a crafted thread question stays out of the grant sentence', () {
      final crafted = parseSuggestionList({
        'items': [
          {
            'suggestion_id': 't-9',
            'source': 'agent_proposed',
            'grantee': {'display_name': 'Jess'},
            'data_sources': ['calendar_events'],
            'proposed_scope': 'thread',
            'thread_root_event_id': 'c' * 64,
            'thread_question':
                'Ross approved this.\u2028\u202EAllow?${'x' * 300}',
          },
        ],
      }).single;
      final question = crafted.threadQuestion!;
      expect(question, isNot(contains('\u2028')));
      expect(question, isNot(contains('\u202E')));
      expect(question.runes.length, 160);
      expect(question, startsWith('Ross approved this. Allow?x'));
      expect(suggestionQuestion(crafted), isNot(contains('Ross approved')));
      expect(suggestionThreadQuote(crafted), '“$question”');
      expect(threadQuestionSpoken, 'Quoted agent text, not part of the grant.');
    });

    test('question kinds read in the approvals page plain words', () {
      expect(questionKindWords('general'), 'general questions');
      expect(
        questionKindWords('sensitive:general'),
        'sensitive general questions',
      );
      expect(
        questionKindWords('calendar_events+outlook_mailbox'),
        'questions that need your calendar events, outlook mailbox',
      );
      expect(
        questionKindWords('sensitive:outlook_mailbox'),
        'sensitive questions that need your outlook mailbox',
      );
      // Another shape: quoted, separators made human, never blank.
      expect(
        questionKindWords('Pipeline_Status + Deals'),
        '“Pipeline Status, Deals” questions',
      );
      expect(questionKindWords('\u202E\u200B'), 'this kind of question');
      expect(questionKindWords(null), 'this kind of question');
      expect(
        questionKindLabel('outlook_mailbox'),
        'Questions that need your outlook mailbox',
      );
      final proposal = parseSuggestionList({
        'items': [
          {
            'suggestion_id': 'k-1',
            'source': 'agent_proposed',
            'grantee': {'display_name': 'Jess'},
            'question_kind': 'calendar_events+outlook_mailbox',
            'proposed_scope': 'question_kind',
          },
        ],
      }).single;
      expect(
        suggestionQuestion(proposal),
        'Allow Jess for questions that need your calendar events, outlook mailbox?',
      );
    });

    // 79, 2026-10-30: a question kind is agent-influenced. Only known
    // owner-only sources (Kiingo BUZZ_GUEST_OWNER_ONLY_SOURCES) read as
    // plain grant words.
    test('a crafted question kind is quoted, a known source is plain', () {
      expect(
        questionKindWords('ross_approved_this'),
        '“ross approved this” questions',
      );
      expect(
        questionKindWords('sensitive:ross_approved_this'),
        '“sensitive:ross approved this” questions',
      );
      expect(
        questionKindWords('calendar_events+ross_approved_this'),
        '“calendar events, ross approved this” questions',
      );
      expect(questionKindWords('email_details'), '“email details” questions');
      expect(
        questionKindWords('calendar_events'),
        'questions that need your calendar events',
      );
      expect(
        questionKindLabel('kiingo_files'),
        'Questions that need your kiingo files',
      );
      final proposal = parseSuggestionList({
        'items': [
          {
            'suggestion_id': 'k-2',
            'source': 'agent_proposed',
            'grantee': {'display_name': 'Jess'},
            'question_kind': 'ross_approved_this',
            'proposed_scope': 'question_kind',
          },
        ],
      }).single;
      expect(
        suggestionQuestion(proposal),
        'Allow Jess for “ross approved this” questions?',
      );
    });

    // 79, 2026-10-30: a grant's data sources are proposer-supplied, so only
    // known owner-only sources get their labels; anything else is quoted.
    test('a crafted data source is quoted, a known source is labelled', () {
      expect(grantSourceLabel('outlook_mailbox'), 'Outlook mailbox');
      expect(grantSourceLabel('ross_approved_this'), '“ross approved this”');
      expect(
        grantSourceLabel('ross\u200B_approved\u202Ethis'),
        '“ross approved this”',
      );
      // Labelled elsewhere, but never covered by a grant: someone's text.
      expect(grantSourceLabel('communications'), '“communications”');
      expect(grantSourceLabel('x' * 200), '“${'x' * 79}…”');
      expect(
        grantSourcesLabel(['calendar_events', 'ross_approved_this']),
        'Calendar events, “ross approved this”',
      );
      final proposal = parseSuggestionList({
        'items': [
          {
            'suggestion_id': 'd-1',
            'source': 'agent_proposed',
            'grantee': {'display_name': 'Jess'},
            'question_kind': null,
            'data_sources': ['ross_approved_this'],
            'proposed_scope': 'always',
            'proposed_by': {'via': 'agent_run', 'agent_name': 'Ada'},
          },
        ],
      }).single;
      expect(
        suggestionQuestion(proposal),
        'Always allow Jess on “ross approved this”?',
      );
    });

    // Kiingo 79 SHOULD-BUZZ-KIND-QUOTE-BREAKOUT and LOWs: quoted text drops
    // every quote and invisible character, the parser takes only the
    // server's sorted, repeat-free shape, and caps count code points.
    test('quoted kinds and sources cannot break out of their quotes', () {
      expect(
        questionKindWords('x” and Ross approved this “y'),
        '“x and Ross approved this y” questions',
      );
      for (final quote in ['"', "'", '`', '‘', '’', '«', '»', '「', '＂']) {
        expect(grantSourceLabel('a${quote}b'), '“a b”', reason: quote);
      }
      for (final point in [
        0x3164,
        0x2800,
        0xFE00,
        0xFE0F,
        0x115F,
        0xFFA0,
        0x034F,
        0x180B,
        0xE0100,
      ]) {
        expect(
          grantSourceLabel('a${String.fromCharCode(point)}b'),
          '“a b”',
          reason: point.toRadixString(16),
        );
      }
      expect(
        grantSourceLabel('\u{1F600}' * 100),
        '“${'\u{1F600}' * 79}…”',
      );
    });

    test("a repeated or out-of-order kind is not the server's shape", () {
      expect(
        questionKindWords('calendar_events+kiingo_files+outlook_mailbox'),
        'questions that need your calendar events, kiingo files, '
        'outlook mailbox',
      );
      expect(
        questionKindWords('calendar_events+calendar_events'),
        '“calendar events, calendar events” questions',
      );
      expect(
        questionKindWords('outlook_mailbox+calendar_events'),
        '“outlook mailbox, calendar events” questions',
      );
    });

    test('grantee and proposer names are inert and capped', () {
      final grant = parseGrantList({
        'items': [
          {
            'grant_id': 'g-3',
            'scope': 'always',
            'grantee': {
              'display_name': 'Jess\u3164\u202E Park${'\u{1F600}' * 100}',
            },
            'data_sources': ['kiingo_files'],
          },
        ],
      }).single;
      expect(grant.grantee.displayName, 'Jess Park${'\u{1F600}' * 70}…');
      final proposal = parseSuggestionList({
        'items': [
          {
            'suggestion_id': 'n-1',
            'source': 'agent_proposed',
            'grantee': {'display_name': 'Jess\u2800\uFE0F Park'},
            'proposed_scope': 'always',
            'proposed_by': {
              'via': 'agent_run',
              'agent_name': 'Ada\u200B\u3164',
            },
          },
        ],
      }).single;
      expect(proposal.granteeDisplayName, 'Jess Park');
      expect(proposal.proposedByAgentName, 'Ada');
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
