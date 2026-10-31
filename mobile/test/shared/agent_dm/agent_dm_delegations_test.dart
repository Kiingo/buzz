import 'dart:async';
import 'dart:convert';

import 'package:buzz/shared/agent_dm/agent_dm_delegation_client.dart';
import 'package:buzz/shared/agent_dm/agent_dm_delegations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:nostr/nostr.dart' as nostr;

const _agentKey =
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const _agent = '0192a6b0-0000-6000-8000-0000000000a1';
const _task = '0192a6b0-0000-6000-8000-0000000000b1';
const _task2 = '0192a6b0-0000-6000-8000-0000000000b2';
const _session = '0192a6b0-0000-6000-8000-0000000000c1';
const _ask = '0192a6b0-0000-6000-8000-0000000000e1';

String _id(int n) => '0192a6b0-0000-6000-8000-${n.toString().padLeft(12, '0')}';

Map<String, Object?> _card(int n, [Map<String, Object?> extra = const {}]) => {
  'delegationId': _id(n),
  'revision': 1,
  'title': 'Worker $n',
  'harness': 'codex',
  'state': 'running',
  'stalled': false,
  'taskId': _task,
  'taskTitle': 'Ship the thing',
  'workerSessionId': _session,
  'startedAt': '2026-10-31T10:0$n:00Z',
  'finishedAt': null,
  'elapsedSeconds': 90,
  'cost': {'costUsd': 0.42},
  'lastProgressLine': 'Reading the repo',
  'result': null,
  'pendingAsksCount': 0,
  ...extra,
};

Map<String, Object?> _page(
  List<Map<String, Object?>> cards, [
  Map<String, Object?> summary = const {},
]) => {
  'rev': 'r1',
  'serverNow': '2026-10-31T10:10:00Z',
  'agent': {'id': _agent, 'name': 'Ada'},
  'summary': {
    'runningCount': 1,
    'needsYouCount': 0,
    'stalledCount': 0,
    'costTodayUsd': 4.1,
    'canStopAll': true,
    ...summary,
  },
  'cards': cards,
};

DelegationCard _parsed(int n, [Map<String, Object?> extra = const {}]) =>
    DelegationCard.tryParse(_card(n, extra))!;

void main() {
  group('reading the board', () {
    test('a page parses, dropping malformed and repeated cards', () {
      final poll = DelegationPoll.tryParse(
        _page([
          _card(1),
          _card(1),
          {..._card(2), 'state': 'exploded'},
          {'title': 'x'},
        ]),
      )!;
      expect(poll.page!.cards, hasLength(1));
      expect(poll.page!.agentName, 'Ada');
      expect(poll.page!.cards.single.costUsd, 0.42);
      final unchanged = DelegationPoll.tryParse({
        'rev': 'r2',
        'unchanged': true,
      })!;
      expect(unchanged.page, isNull);
      expect(unchanged.rev, 'r2');
      expect(DelegationPoll.tryParse({'rev': 'r2'}), isNull);
      expect(DelegationPoll.tryParse(null), isNull);
    });

    test('progress is never a result, and a running card has none', () {
      final running = _parsed(1, {
        'result': {'summary': 'All done', 'outcome': 'done'},
      });
      expect(running.result, isNull);
      expect(running.lastProgressLine, 'Reading the repo');
      final done = _parsed(2, {
        'state': 'done',
        'result': {'summary': 'Merged', 'outcome': 'done'},
      });
      expect(done.result!.summary, 'Merged');
      expect(_parsed(3, {'state': 'done', 'stalled': true}).stalled, isFalse);
    });

    test('the header reads running, needs you and today’s cost', () {
      expect(
        delegationHeaderText(
          const DelegationSummary(
            runningCount: 3,
            needsYouCount: 1,
            costTodayUsd: 4.1,
          ),
        ),
        r'3 running · 1 needs you · $4.10 today',
      );
      expect(delegationHeaderText(const DelegationSummary()), isNull);
      expect(
        delegationHeaderText(const DelegationSummary(runningCount: 2)),
        '2 running',
      );
    });
  });

  group('the board', () {
    test('three or more running cards fold; asks come first', () {
      final cards = [
        for (final n in [1, 2, 3]) _parsed(n),
      ];
      expect(delegationBoard(cards).folded, isTrue);
      expect(delegationBoard(cards.sublist(0, 2)).folded, isFalse);
      final asking = _parsed(4, {'pendingAsksCount': 1});
      final board = delegationBoard([...cards.sublist(0, 2), asking]);
      expect(board.needsYou.map((c) => c.delegationId), [_id(4)]);
      expect(board.running, hasLength(2));
      expect(delegationStateLabel(asking), 'needs you');
    });

    test('one done summary per task, once no worker on it is active', () {
      final doneA = _parsed(1, {
        'state': 'done',
        'finishedAt': '2026-10-31T10:05:00Z',
        'result': {'summary': 'Drafted', 'outcome': 'done'},
      });
      final failedA = _parsed(2, {
        'state': 'failed',
        'finishedAt': '2026-10-31T10:06:00Z',
        'result': {'summary': 'Timed out', 'outcome': 'failed'},
      });
      final runningA = _parsed(3);
      final doneB = _parsed(4, {
        'state': 'done',
        'taskId': _task2,
        'taskTitle': 'Other',
        'finishedAt': '2026-10-31T10:07:00Z',
        'result': {'summary': 'Fixed', 'outcome': 'done'},
      });
      expect(
        delegationBoard([
          doneA,
          failedA,
          runningA,
          doneB,
        ]).done.map((s) => s.key),
        [_task2],
      );
      final board = delegationBoard([doneA, failedA, doneB]);
      expect(board.done.map((s) => s.key), [_task2, _task]);
      expect(board.done[0].heading, 'Done · Other');
      expect(board.done[1].heading, 'Finished · Ship the thing');
      expect(board.done[1].workers, hasLength(2));
      expect(
        delegationBoard(
          [doneA, doneB],
          hidden: {_task2},
        ).done.map((s) => s.key),
        [_task],
      );
    });

    test('a worker ask keeps its open state, options and recommendation', () {
      final asks = parseDelegationAsks({
        'delegation': {
          'pendingAsks': [
            {
              'id': _ask,
              'delegationId': _id(1),
              'workerTitle': 'Research',
              'question': 'Which repo?',
              'options': ['kiingo', 'buzz', 'buzz', ' '],
              'recommendation': 'buzz',
              'state': 'open',
            },
            {
              'id': _id(10),
              'delegationId': _id(1),
              'question': 'Old',
              'state': 'answered',
            },
            {'id': 'nope', 'delegationId': _id(1), 'question': 'Bad'},
          ],
        },
      });
      expect(asks, hasLength(1));
      expect(asks.single.options, ['kiingo', 'buzz']);
      expect(asks.single.recommendation, 'buzz');
      expect(asks.single.fromWorkerLabel, 'from worker: Research');
      expect(parseDelegationAsks(const {}), isEmpty);
    });

    test('links, time and money', () {
      expect(
        delegationTaskLink(_task.toUpperCase()),
        'kiingotasks://task/$_task',
      );
      expect(
        delegationAppOrigin('https://api.kiingo.com'),
        'https://app.kiingo.com',
      );
      expect(delegationAppOrigin('http://127.0.0.1:3000'), isNull);
      expect(delegationAppOrigin('https://voice.kiingo.com'), isNull);
      expect(
        delegationSessionLink('https://app.kiingo.com', _session),
        'https://app.kiingo.com/team/harness-sessions/$_session/feed',
      );
      const byKey = 'agents/-/delegations?agentPubkey=$_agentKey';
      expect(delegationsPath(_agentKey.toUpperCase(), null), byKey);
      expect(
        delegationsPath(_agentKey, 'a:b/c'),
        '$byKey&rev=a%3Ab%2Fc&wait=20',
      );
      // Desktop's native route check admits only letters, digits, `-_.%`.
      expect(
        delegationsPath(_agentKey, "r!'()*~"),
        '$byKey&rev=r%21%27%28%29%2A%7E&wait=20',
      );
      expect(delegationChatPath(_agent), 'agents/$_agent/chat?limit=1');
      expect(formatDelegationElapsed(45), '45s');
      expect(formatDelegationElapsed(720), '12m');
      expect(formatDelegationElapsed(3900), '1h 05m');
      expect(formatDelegationUsd(0), isNull);
      expect(formatDelegationUsd(4.1), r'$4.10');
      expect(
        delegationLiveElapsed(
          _parsed(1),
          '2026-10-31T10:10:00Z',
          DateTime.parse('2026-10-31T10:11:00Z'),
        ),
        150,
      );
    });
  });

  group('the live board', () {
    ProviderContainer containerWith(MockClient http) {
      final keys = nostr.Keys.generate();
      final container = ProviderContainer(
        overrides: [
          delegationClientProvider.overrideWithValue(
            DelegationClient(
              origin: 'https://api.example.com',
              communityId: 'chat.example.com',
              nsec: keys.nsec,
              httpClient: http,
            ),
          ),
        ],
      );
      addTearDown(container.dispose);
      return container;
    }

    Future<DelegationBoardState> settle(
      ProviderContainer container,
      bool Function(DelegationBoardState) done,
    ) async {
      final sub = container.listen(
        delegationBoardProvider(_agentKey),
        (_, _) {},
      );
      addTearDown(sub.close);
      for (var i = 0; i < 200; i++) {
        final state = container.read(delegationBoardProvider(_agentKey));
        if (done(state)) return state;
        await Future<void>.delayed(const Duration(milliseconds: 5));
      }
      fail('timed out');
    }

    test('reads cards by key and their asks, long-polls, and acts', () async {
      final sent = <http.Request>[];
      final hold = Completer<http.Response>();
      final container = containerWith(
        MockClient((request) async {
          sent.add(request);
          final path = request.url.path;
          final query = request.url.query;
          if (path.endsWith('/agents/-/delegations') &&
              query == 'agentPubkey=$_agentKey') {
            return http.Response(
              jsonEncode(
                _page([
                  _card(1, {'state': 'needs_input', 'pendingAsksCount': 1}),
                ]),
              ),
              200,
            );
          }
          if (path.endsWith('/agents/-/delegations')) return hold.future;
          if (path.endsWith('/delegations/${_id(1)}')) {
            return http.Response(
              jsonEncode({
                'delegation': {
                  'pendingAsks': [
                    {
                      'id': _ask,
                      'delegationId': _id(1),
                      'workerTitle': 'Worker 1',
                      'question': 'Which repo?',
                      'options': ['buzz'],
                    },
                  ],
                },
              }),
              200,
            );
          }
          if (path.endsWith('/cancel-all')) {
            return http.Response(
              jsonEncode({
                'cancelledIds': [_id(1)],
                'alreadyFinishedCount': 0,
              }),
              200,
            );
          }
          return http.Response('{}', 200);
        }),
      );
      final ready =
          await settle(container, (state) => state is DelegationBoardReady)
              as DelegationBoardReady;
      expect(ready.agentId, _agent);
      expect(ready.asks[_id(1)]!.single.id, _ask);
      expect(ready.ack, isNull);
      expect(
        sent.first.url.toString(),
        'https://api.example.com/api/buzz-voice/ios/agents/-/delegations?agentPubkey=$_agentKey',
      );
      expect(sent.first.headers['X-Buzz-Community'], 'chat.example.com');
      expect(sent.first.headers['Authorization'], startsWith('Nostr '));
      expect(sent.any((r) => r.url.path.endsWith('/settings')), isFalse);
      const poll = 'agentPubkey=$_agentKey&rev=r1&wait=20';
      for (var i = 0; i < 200; i++) {
        if (sent.any((r) => r.url.query == poll)) break;
        await Future<void>.delayed(const Duration(milliseconds: 5));
      }
      expect(sent.any((r) => r.url.query == poll), isTrue);

      final notifier = container.read(
        delegationBoardProvider(_agentKey).notifier,
      );
      await notifier.answer(_ask, 'buzz');
      final answer = sent.lastWhere(
        (r) => r.url.path.endsWith('/asks/$_ask/answer'),
      );
      expect(answer.method, 'POST');
      expect(jsonDecode(answer.body), {'answer': 'buzz'});
      expect(await notifier.cancelAll(), 1);
      expect(
        sent.any(
          (r) =>
              r.method == 'POST' &&
              r.url.path.endsWith('/agents/$_agent/delegations/cancel-all'),
        ),
        isTrue,
      );
    });

    test('anyone but the owner gets no board (D5)', () async {
      final container = containerWith(
        MockClient(
          (request) async =>
              http.Response(jsonEncode({'error': 'not_found'}), 404),
        ),
      );
      await settle(container, (state) => state is DelegationBoardHidden);
    });

    test('a host that cannot resolve the key gets no board', () async {
      final container = containerWith(
        MockClient(
          (request) async => http.Response(
            jsonEncode({'error': 'invalid_request', 'field': 'agentPubkey'}),
            400,
          ),
        ),
      );
      await settle(container, (state) => state is DelegationBoardHidden);
    });

    test(
      'the pending ack shows until a chat page arrives without it',
      () async {
        var replied = false;
        var chatReads = 0;
        final hold = Completer<http.Response>();
        final ack = {
          'id': 'ack:${_id(1)}',
          'text': 'Starting 1 worker: Worker 1',
          'delegationIds': [_id(1)],
          'titles': ['Worker 1'],
          'createdAt': '2026-10-31T10:10:00Z',
          'expiresAt': DateTime.now()
              .add(const Duration(minutes: 1))
              .toUtc()
              .toIso8601String(),
          'afterSequence': 4,
        };
        final container = containerWith(
          MockClient((request) async {
            final path = request.url.path;
            if (path.endsWith('/agents/$_agent/chat')) {
              chatReads++;
              return http.Response(
                jsonEncode({
                  'rev': replied ? 'c2' : 'c1',
                  if (!replied)
                    'delegations': {
                      'summary': <String, Object?>{},
                      'activeDelegationIds': <String>[],
                      'pendingAck': ack,
                    },
                }),
                200,
              );
            }
            if (request.url.query == 'agentPubkey=$_agentKey') {
              return http.Response(jsonEncode(_page([_card(1)])), 200);
            }
            return hold.future;
          }),
        );
        final shown =
            await settle(
                  container,
                  (state) => state is DelegationBoardReady && state.ack != null,
                )
                as DelegationBoardReady;
        expect(shown.ack!.text, 'Starting 1 worker: Worker 1');
        replied = true;
        for (var i = 0; i < 100; i++) {
          final state = container.read(delegationBoardProvider(_agentKey));
          if (state is DelegationBoardReady && state.ack == null) break;
          await Future<void>.delayed(const Duration(milliseconds: 50));
        }
        final cleared =
            container.read(delegationBoardProvider(_agentKey))
                as DelegationBoardReady;
        expect(cleared.ack, isNull);
        final reads = chatReads;
        await Future<void>.delayed(const Duration(milliseconds: 100));
        expect(chatReads, reads, reason: 'no re-reads once the ack is gone');
      },
    );

    test('since is read once per viewing; Mark seen and Undo post', () async {
      final sent = <http.Request>[];
      final hold = Completer<http.Response>();
      final container = containerWith(
        MockClient((request) async {
          sent.add(request);
          final path = request.url.path;
          if (path.endsWith('/agents/$_agent/delegations/since')) {
            return http.Response(
              jsonEncode({
                'seenAt': null,
                'latestAt': '2026-10-31T10:05:00Z',
                'serverNow': '2026-10-31T10:10:00Z',
                'finished': {
                  'count': 1,
                  'delegationIds': [_id(1)],
                },
                'failed': {'count': 0, 'delegationIds': <String>[]},
                'cancelled': {'count': 0, 'delegationIds': <String>[]},
                'started': {'count': 0, 'delegationIds': <String>[]},
                'newQuestions': {
                  'count': 0,
                  'askIds': <String>[],
                  'delegationIds': <String>[],
                },
                'changedDelegationIds': [_id(1)],
              }),
              200,
            );
          }
          if (request.method == 'POST') {
            return http.Response(
              jsonEncode({'seenAt': '2026-10-31T10:05:00Z'}),
              200,
            );
          }
          if (request.url.query == 'agentPubkey=$_agentKey') {
            return http.Response(jsonEncode(_page([_card(1)])), 200);
          }
          if (path.endsWith('/chat')) return http.Response('{}', 200);
          return hold.future;
        }),
      );
      final shown =
          await settle(
                container,
                (state) => state is DelegationBoardReady && state.since != null,
              )
              as DelegationBoardReady;
      expect(shown.since!.text, '1 finished');
      final notifier = container.read(
        delegationBoardProvider(_agentKey).notifier,
      );
      await notifier.markSeen();
      final after =
          container.read(delegationBoardProvider(_agentKey))
              as DelegationBoardReady;
      expect(after.since, isNull);
      final seen = sent.singleWhere(
        (r) => r.url.path.endsWith('/agents/$_agent/delegations/seen'),
      );
      expect(seen.method, 'POST');
      expect(jsonDecode(seen.body), {'at': '2026-10-31T10:05:00Z'});
      await notifier.undoStop(_id(1));
      expect(
        sent.any(
          (r) =>
              r.method == 'POST' &&
              r.url.path.endsWith(
                '/agents/$_agent/delegations/${_id(1)}/undo-stop',
              ),
        ),
        isTrue,
      );
      expect(
        sent.where((r) => r.url.path.endsWith('/delegations/since')).length,
        1,
        reason: 'read once per viewing, not on every page',
      );
    });
  });

  group('since you last looked and Undo Stop', () {
    test('Undo shows only on a stopped card inside its window', () {
      const serverNow = '2026-10-31T10:10:00Z';
      final at = DateTime.parse(serverNow);
      DelegationCard stopped(
        int n,
        String until, [
        String state = 'cancelled',
      ]) => DelegationCard.tryParse(
        _card(n, {
          'state': state,
          'finishedAt': '2026-10-31T10:09:5${n}Z',
          'undoStopUntil': until,
        }),
      )!;
      final open = stopped(1, '2026-10-31T10:10:30Z');
      expect(
        delegationUndoRemaining(open, serverNow, at),
        const Duration(seconds: 30),
      );
      expect(
        delegationUndoRemaining(
          open,
          serverNow,
          at.add(const Duration(seconds: 10)),
        ),
        const Duration(seconds: 20),
      );
      expect(
        delegationUndoRemaining(
          open,
          serverNow,
          at.add(const Duration(seconds: 31)),
        ),
        Duration.zero,
      );
      // A stale reader clock never stretches the window past serverNow.
      expect(
        delegationUndoRemaining(
          open,
          serverNow,
          at.subtract(const Duration(minutes: 1)),
        ),
        const Duration(seconds: 30),
      );
      final passed = stopped(2, '2026-10-31T10:09:59Z');
      final done = stopped(3, '2026-10-31T10:10:30Z', 'done');
      expect(done.undoStopUntil, isNull);
      final later = stopped(4, '2026-10-31T10:10:40Z');
      expect(
        undoableDelegations(
          [open, passed, done, later],
          serverNow,
          at,
        ).map((c) => c.delegationId),
        [_id(4), _id(1)],
      );
      expect(
        delegationUndoStopPath(_agent, _id(1)),
        'agents/$_agent/delegations/${_id(1)}/undo-stop',
      );
    });

    test('since reads as one chip, or none', () {
      Map<String, Object?> since(Map<String, Object?> counts) => {
        'seenAt': null,
        'latestAt': '2026-10-31T10:00:00Z',
        'serverNow': '2026-10-31T10:10:00Z',
        'finished': {'count': 0},
        'failed': {'count': 0},
        'cancelled': {'count': 0},
        'started': {'count': 0},
        'newQuestions': {'count': 0},
        ...counts,
      };
      expect(DelegationSince.tryParse(since({})), isNull);
      final chip = DelegationSince.tryParse(
        since({
          'finished': {'count': 2},
          'failed': {'count': 1},
          'newQuestions': {'count': 1},
        }),
      )!;
      expect(chip.text, '2 finished · 1 failed · 1 new question');
      expect(chip.latestAt, '2026-10-31T10:00:00Z');
      expect(
        DelegationSince.tryParse(
          since({
            'cancelled': {'count': 3},
          }),
        )!.text,
        '3 stopped',
      );
      expect(DelegationSince.tryParse(<String, Object?>{}), isNull);
      expect(delegationSincePath(_agent), 'agents/$_agent/delegations/since');
      expect(delegationSeenPath(_agent), 'agents/$_agent/delegations/seen');
    });
  });
}
