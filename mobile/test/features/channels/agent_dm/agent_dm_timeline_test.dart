import 'package:buzz/features/channels/agent_dm/agent_dm_timeline.dart';
import 'package:buzz/features/channels/timeline_message.dart';
import 'package:buzz/shared/relay/relay.dart';
import 'package:flutter_test/flutter_test.dart';

const _agent =
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const _me = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const _outsider =
    'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

NostrEvent _event(
  String id,
  List<List<String>> markers, {
  int kind = EventKind.streamMessageV2,
  String signer = _agent,
  int createdAt = 10,
}) => NostrEvent(
  id: id,
  pubkey: signer,
  createdAt: createdAt,
  kind: kind,
  tags: [
    ['h', 'dm'],
    ...markers,
  ],
  content: 'content $id',
  sig: 'sig',
);

TimelineMessage _message(NostrEvent event) => TimelineMessage(
  id: event.id,
  pubkey: event.pubkey,
  createdAt: event.createdAt,
  content: event.content,
  tags: event.tags,
);

AgentDmTimeline _build(
  List<NostrEvent> events, {
  bool isDm = true,
  List<String> members = const [_agent, _me],
  Map<String, String> owners = const {_agent: _me},
  Set<String> agents = const {_agent},
}) => AgentDmTimeline.build(
  events: events,
  isDm: isDm,
  memberPubkeys: members,
  currentPubkey: _me,
  agentPubkeys: agents,
  verifiedAgentOwners: owners,
);

const _question = [
  ['buzz-question', 'ask-1'],
  ['buzz-question-item', 'q1', 'Ship?', '', '0', '0'],
  ['buzz-question-option', 'q1', 'Yes', ''],
];

void main() {
  final mirror = _event('mirror', const [
    ['buzz-mirror', 'email', 'm-1', '1700000000'],
    ['buzz-mirror-author', 'requester', _me, 'Ross'],
  ]);
  final relayed = _event('relayed', const [
    ['buzz-mirror', 'teams', 'm-2', '1700000000'],
    ['buzz-mirror-author', 'requester', _outsider, 'Mallory'],
  ]);
  final divider = _event('divider', const [
    ['buzz-session', 'load', 's-1'],
  ]);
  final listing = _event('listing', const [
    ['buzz-sessions', ''],
    ['buzz-session-item', 's-1', 'current', '1', '2', 'Now', '1', '4'],
  ]);
  final state = _event('state', const [
    ['buzz-question-state', 'ask-1', 'closed'],
  ], createdAt: 20);
  final question = _event('question', _question, kind: EventKind.streamMessage);

  test('indexes markers only in a DM', () {
    final timeline = _build([mirror, divider, listing, state, question]);
    expect(timeline.mirrorOf('mirror'), isNotNull);
    expect(timeline.dividerOf('divider')?.label, 'Earlier session loaded');
    expect(timeline.listingOf('listing')?.listing.items.single.title, 'Now');
    expect(timeline.hidesRow('state'), isTrue);
    expect(timeline.questionOf('question')?.askId, 'ask-1');

    final stream = _build([mirror, divider, question], isDm: false);
    expect(stream.mirrorOf('mirror'), isNull);
    expect(stream.dividerOf('divider'), isNull);
    expect(stream.questionOf('question'), isNull);
  });

  test('ignores markers from non-members and on the wrong kind', () {
    final timeline = _build([
      _event('foreign', const [
        ['buzz-session', 'new', ''],
      ], signer: _outsider),
      _event('kind9', const [
        ['buzz-session', 'new', ''],
      ], kind: EventKind.streamMessage),
      _event('quiet-question', _question),
    ]);
    expect(timeline.dividerOf('foreign'), isNull);
    expect(timeline.dividerOf('kind9'), isNull);
    expect(timeline.questionOf('quiet-question'), isNull);
  });

  test('question cards and actions need an agent signer other than me', () {
    final timeline = _build([
      _event('mine', _question, kind: EventKind.streamMessage, signer: _me),
    ]);
    expect(timeline.questionOf('mine'), isNull);
  });

  test('requester mirrors show a member author or say who relayed them', () {
    final timeline = _build([mirror, relayed]);
    expect(timeline.authorOf(_message(mirror)), _me);
    // Every requester mirror takes the relayed style, even when it is
    // attributed to the member it names.
    expect(timeline.isRelayed(_message(mirror)), isTrue);
    expect(timeline.authorOf(_message(relayed)), _agent);
    expect(timeline.isRelayed(_message(relayed)), isTrue);
  });

  test('the shared rule names the requester and who relayed the line', () {
    final timeline = _build([mirror, relayed]);
    String names(String pubkey) => pubkey == _me ? 'Ross' : 'Juniper';
    final display = timeline.mirrorDisplayOf(_message(mirror), names)!;
    expect(display.authorPubkey, _me);
    expect(display.authorName, 'Ross');
    expect(display.relayedByName, 'Juniper');
    expect(display.relayLine, 'via email · relayed by Juniper');
    expect(
      display.plainText('Move my 3pm'),
      'Ross (via email, relayed by Juniper): Move my 3pm',
    );
    final fallback = timeline.mirrorDisplayOf(_message(relayed), names)!;
    expect(fallback.authorPubkey, _agent);
    expect(fallback.plainText('Hi'), 'Relayed by Juniper (via Teams): Hi');
    expect(timeline.mirrorDisplayOf(_message(divider), names), isNull);
  });

  test('a mirror from a signer not known as an agent keeps its signer', () {
    final timeline = _build([mirror], agents: const {});
    expect(timeline.authorOf(_message(mirror)), _agent);
    expect(timeline.isRelayed(_message(mirror)), isTrue);
  });

  test('agent-role mirrors are not relayed', () {
    final own = _event('own', const [
      ['buzz-mirror', 'teams', 'm-3', '1700000000'],
      ['buzz-mirror-author', 'agent', '', ''],
    ]);
    final timeline = _build([own]);
    expect(timeline.isRelayed(_message(own)), isFalse);
    expect(
      timeline.mirrorDisplayOf(_message(own), (_) => 'Juniper')?.relayLine,
      'via Teams',
    );
  });

  group('question status', () {
    test('open, then closed by the asking agent', () {
      expect(
        _build([question]).questionStatusOf('question'),
        AgentDmQuestionStatus.open,
      );
      expect(
        _build([question, state]).questionStatusOf('question'),
        AgentDmQuestionStatus.closed,
      );
    });

    test('an answer from the other member wins over closed', () {
      final answer = _event(
        'answer',
        const [
          ['buzz-answer', 'ask-1'],
        ],
        kind: EventKind.streamMessage,
        signer: _me,
        createdAt: 15,
      );
      expect(
        _build([question, state, answer]).questionStatusOf('question'),
        AgentDmQuestionStatus.answered,
      );
    });

    test('the agent answering its own ask does not count', () {
      final selfAnswer = _event('self', const [
        ['buzz-answer', 'ask-1'],
      ], kind: EventKind.streamMessage);
      expect(
        _build([question, selfAnswer]).questionStatusOf('question'),
        AgentDmQuestionStatus.open,
      );
    });

    test('an answered state event marks the card answered', () {
      final answered = _event('answered', const [
        ['buzz-question-state', 'ask-1', 'answered'],
      ], createdAt: 30);
      expect(
        _build([question, state, answered]).questionStatusOf('question'),
        AgentDmQuestionStatus.answered,
      );
    });
  });

  test('actions are used once my message carries one of their refs', () {
    final reply = _event('reply', const [
      ['buzz-action', 'retry', 'Retry', 'retry', 'primary', 'ref-1'],
      [
        'buzz-action',
        'continue_on_claude',
        'Continue',
        'go',
        'secondary',
        'ref-2',
      ],
    ], kind: EventKind.streamMessage);
    expect(_build([reply]).actionsOf('reply'), hasLength(2));
    expect(_build([reply]).actionsUsed('reply'), isFalse);
    final tap = _event(
      'tap',
      const [
        ['buzz-action-ref', 'ref-2'],
      ],
      kind: EventKind.streamMessage,
      signer: _me,
    );
    expect(_build([reply, tap]).actionsUsed('reply'), isTrue);
  });

  test('newestListing picks the latest listing from the signer', () {
    final older = _event('older', const [
      ['buzz-sessions', ''],
    ], createdAt: 5);
    final newer = _event('newer', const [
      ['buzz-sessions', ''],
    ], createdAt: 50);
    final timeline = _build([newer, older]);
    expect(timeline.newestListing(signerPubkey: _agent)?.eventId, 'newer');
    expect(timeline.newestListing(signerPubkey: _me), isNull);
    expect(timeline.listingIdsFrom(_agent), {'newer', 'older'});
  });

  test('present drops state rows and makes dividers and listings system', () {
    final timeline = _build([mirror, divider, listing, state]);
    final presented = timeline.present([
      for (final event in [mirror, divider, listing, state]) _message(event),
    ]);
    expect(presented.map((m) => m.id), ['mirror', 'divider', 'listing']);
    expect(presented.map((m) => m.isSystem), [false, true, true]);
  });

  test('indexes agent surface cards and their newest revision', () {
    const id = '0b5c1f7e-8a7d-4d1e-9a51-3c2f1e0d9b88';
    final first = _event('s1', const [
      ['buzz-surface', id, '1'],
    ]);
    final second = _event('s2', const [
      ['buzz-surface', id, '3'],
    ], createdAt: 20);
    final mine = _event('s3', const [
      ['buzz-surface', id, '9'],
    ], signer: _me);
    final outsider = _event('s4', const [
      ['buzz-surface', id, '9'],
    ], signer: _outsider);
    final timeline = _build([first, second, mine, outsider]);
    expect(timeline.surfaceOf('s1')?.revision, 1);
    expect(timeline.surfaceOf('s2')?.revision, 3);
    expect(timeline.surfaceOf('s3'), isNull);
    expect(timeline.surfaceOf('s4'), isNull);
    expect(timeline.newestSurfaceRevision(id), 3);

    final notDm = _build([first], isDm: false);
    expect(notDm.surfaceOf('s1'), isNull);
  });

  test('draws agent cards only from a verified agent in a 1:1 DM', () {
    const id = '0b5c1f7e-8a7d-4d1e-9a51-3c2f1e0d9b88';
    final card = _event('s1', const [
      ['buzz-surface', id, '1'],
    ]);
    // A self-published agent profile (kind 10100) alone draws nothing.
    expect(_build([card], owners: const {}).surfaceOf('s1'), isNull);
    // Someone else's verified agent draws nothing (79 S6).
    expect(
      _build([card], owners: const {_agent: _outsider}).surfaceOf('s1'),
      isNull,
    );
    // A group DM draws nothing, even from a verified agent.
    expect(
      _build([card], members: const [_agent, _me, _outsider]).surfaceOf('s1'),
      isNull,
    );
    expect(_build([card]).surfaceOf('s1')?.revision, 1);
    expect(_build([card]).signerOf('s1'), _agent);
  });

  test('ignores a surface marker with extra elements', () {
    const id = '0b5c1f7e-8a7d-4d1e-9a51-3c2f1e0d9b88';
    final card = _event('s1', const [
      ['buzz-surface', id, '1', 'extra'],
    ]);
    expect(_build([card]).surfaceOf('s1'), isNull);
  });
}
