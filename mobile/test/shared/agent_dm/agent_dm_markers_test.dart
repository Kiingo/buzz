import 'package:buzz/shared/agent_dm/agent_dm_markers.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  const agent =
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const person =
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const outsider =
      'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

  group('agentDmMarkersApply', () {
    test('only in a DM and only for a member signer', () {
      expect(
        agentDmMarkersApply(
          isDm: true,
          signerPubkey: agent.toUpperCase(),
          memberPubkeys: const [agent, person],
        ),
        isTrue,
      );
      expect(
        agentDmMarkersApply(
          isDm: false,
          signerPubkey: agent,
          memberPubkeys: const [agent, person],
        ),
        isFalse,
      );
      expect(
        agentDmMarkersApply(
          isDm: true,
          signerPubkey: outsider,
          memberPubkeys: const [agent, person],
        ),
        isFalse,
      );
      expect(
        agentDmMarkersApply(
          isDm: true,
          signerPubkey: 'not-hex',
          memberPubkeys: const ['not-hex'],
        ),
        isFalse,
      );
    });
  });

  group('readAgentDmMirror', () {
    List<List<String>> tags({
      List<String> mirror = const ['buzz-mirror', 'email', 'm-1', '1700000000'],
      List<String> author = const ['buzz-mirror-author', 'requester', '', ''],
      List<List<String>> extra = const [],
    }) => [
      ['h', 'c'],
      mirror,
      author,
      ...extra,
    ];

    test('reads a well-formed mirror and its subject', () {
      final mirror = readAgentDmMirror(
        tags(
          extra: const [
            ['subject', 'Quarterly plan'],
          ],
        ),
      )!;
      expect(mirror.surface, 'email');
      expect(mirror.sourceId, 'm-1');
      expect(mirror.originalAt, 1700000000);
      expect(mirror.role, AgentDmMirrorRole.requester);
      expect(mirror.subject, 'Quarterly plan');
      expect(mirror.badgeLabel, 'via email');
    });

    test('badges each known surface and falls back to the surface name', () {
      String badge(String surface) => readAgentDmMirror(
        tags(mirror: ['buzz-mirror', surface, 'id', '1']),
      )!.badgeLabel;
      expect(badge('teams'), 'via Teams');
      expect(badge('sms'), 'via SMS');
      expect(badge('web'), 'via web');
      expect(badge('slack'), 'via slack');
    });

    test('rejects malformed required parts', () {
      expect(
        readAgentDmMirror(
          tags(mirror: const ['buzz-mirror', 'Email', 'i', '1']),
        ),
        isNull,
      );
      expect(
        readAgentDmMirror(
          tags(mirror: const ['buzz-mirror', 'email', '', '1']),
        ),
        isNull,
      );
      expect(
        readAgentDmMirror(
          tags(mirror: ['buzz-mirror', 'email', 'x' * 257, '1']),
        ),
        isNull,
      );
      expect(
        readAgentDmMirror(
          tags(mirror: const ['buzz-mirror', 'email', 'i', '-5']),
        ),
        isNull,
      );
      expect(
        readAgentDmMirror(const [
          ['buzz-mirror', 'email', 'i'],
          ['buzz-mirror-author', 'agent', '', ''],
        ]),
        isNull,
      );
      expect(
        readAgentDmMirror(
          tags(mirror: ['buzz-mirror', 'email', 'i', '1' * 13]),
        ),
        isNull,
      );
    });

    test('the first mirror tag decides, as on desktop', () {
      expect(
        readAgentDmMirror(
          tags(mirror: const ['buzz-mirror', 'email', 'i', '1', 'extra']),
        )?.surface,
        'email',
      );
      expect(
        readAgentDmMirror([
          ...tags(),
          const ['buzz-mirror', 'teams', 'j', '2'],
        ])?.surface,
        'email',
      );
      expect(
        readAgentDmMirror([
          const ['buzz-mirror', 'email', 'i', 'soon'],
          ...tags(),
        ]),
        isNull,
      );
    });

    test('a bad author tag fails closed to an unattributed requester', () {
      for (final mirror in [
        readAgentDmMirror(
          tags(author: const ['buzz-mirror-author', 'boss', '', '']),
        ),
        readAgentDmMirror(const [
          ['buzz-mirror', 'email', 'i', '1'],
        ]),
        readAgentDmMirror(
          tags(author: const ['buzz-mirror-author', 'agent', 'short', '']),
        ),
        readAgentDmMirror(
          tags(author: const ['buzz-mirror-author', 'agent', '', '', 'x']),
        ),
        readAgentDmMirror(
          tags(
            author: const ['buzz-mirror-author', 'agent', '', ''],
            extra: const [
              ['buzz-mirror-author', 'agent', '', ''],
            ],
          ),
        ),
      ]) {
        expect(mirror?.role, AgentDmMirrorRole.requester);
        expect(mirror?.authorPubkey, '');
      }
    });

    test('drops an oversized or repeated subject but keeps the mirror', () {
      expect(
        readAgentDmMirror(
          tags(
            extra: [
              ['subject', 's' * 201],
            ],
          ),
        )!.subject,
        isNull,
      );
      expect(
        readAgentDmMirror(
          tags(
            extra: const [
              ['subject', 'a'],
              ['subject', 'b'],
            ],
          ),
        )!.subject,
        isNull,
      );
    });

    test('a requester override needs a distinct 64-hex DM member', () {
      AgentDmMirror requester(String pubkey) => readAgentDmMirror(
        tags(author: ['buzz-mirror-author', 'requester', pubkey, 'Claimed']),
      )!;
      const members = [agent, person];
      expect(
        requester(
          person.toUpperCase(),
        ).authorOverride(signerPubkey: agent, memberPubkeys: members),
        person,
      );
      expect(
        requester(
          outsider,
        ).authorOverride(signerPubkey: agent, memberPubkeys: members),
        isNull,
      );
      expect(
        requester(
          agent,
        ).authorOverride(signerPubkey: agent, memberPubkeys: members),
        isNull,
      );
      expect(
        requester(
          'short',
        ).authorOverride(signerPubkey: agent, memberPubkeys: members),
        isNull,
      );
      final agentRole = readAgentDmMirror(
        tags(author: const ['buzz-mirror-author', 'agent', person, '']),
      )!;
      expect(
        agentRole.authorOverride(signerPubkey: agent, memberPubkeys: members),
        isNull,
      );
    });
  });

  group('readAgentDmSessionDivider', () {
    test('labels new, switch and load', () {
      String? label(String action) => readAgentDmSessionDivider([
        ['buzz-session', action, 's-1'],
      ])?.label;
      expect(label('new'), 'New session');
      expect(label('switch'), 'New session');
      expect(label('load'), 'Earlier session loaded');
      expect(label('reset'), isNull);
    });

    test('allows an empty session id and rejects an unsafe one', () {
      expect(
        readAgentDmSessionDivider(const [
          ['buzz-session', 'new', ''],
        ])?.sessionId,
        '',
      );
      expect(
        readAgentDmSessionDivider(const [
          ['buzz-session', 'load', 'has space'],
        ]),
        isNull,
      );
      expect(
        readAgentDmSessionDivider(const [
          ['buzz-session', 'new'],
        ]),
        isNull,
      );
    });
  });

  group('readAgentDmSessionsListing', () {
    List<String> item(
      String id, {
      String status = 'previous',
      String loadable = '1',
    }) => [
      'buzz-session-item',
      id,
      status,
      '100',
      '200',
      'Title $id',
      loadable,
      '3',
    ];

    test('reads items in order and drops malformed ones', () {
      final listing = readAgentDmSessionsListing([
        const ['buzz-sessions', 'req-1'],
        item('s-1', status: 'current'),
        item('s-2', loadable: '0'),
        item('s 3'),
        item('s-4', status: 'old'),
        const ['buzz-session-item', 's-5'],
        item('s-1'),
      ])!;
      expect(listing.requestId, 'req-1');
      expect(listing.items.map((i) => i.sessionId), ['s-1', 's-2']);
      expect(listing.items.first.isCurrent, isTrue);
      expect(listing.items.first.turnCount, 3);
      expect(listing.items.last.loadable, isFalse);
    });

    test('keeps at most twenty items', () {
      final listing = readAgentDmSessionsListing([
        const ['buzz-sessions', ''],
        for (var i = 0; i < 25; i++) item('s-$i'),
      ])!;
      expect(listing.items, hasLength(agentDmMaxSessionItems));
      expect(listing.items.last.sessionId, 's-19');
    });

    test('requires exactly one listing marker', () {
      expect(readAgentDmSessionsListing([item('s-1')]), isNull);
      expect(
        readAgentDmSessionsListing(const [
          ['buzz-sessions', 'a'],
          ['buzz-sessions', 'b'],
        ]),
        isNull,
      );
    });
  });

  group('readAgentDmQuestionCard', () {
    List<List<String>> card({
      List<List<String>> items = const [
        ['buzz-question-item', 'q1', 'Pick one', 'Plan', '0', '0'],
      ],
      List<List<String>> options = const [
        ['buzz-question-option', 'q1', 'Yes', ''],
        ['buzz-question-option', 'q1', 'No', 'Not now'],
      ],
    }) => [
      const ['buzz-question', 'ask-1'],
      ...items,
      ...options,
    ];

    test('reads questions and options in order', () {
      final parsed = readAgentDmQuestionCard(card())!;
      expect(parsed.askId, 'ask-1');
      expect(parsed.questions.single.header, 'Plan');
      expect(parsed.questions.single.options.map((o) => o.label), [
        'Yes',
        'No',
      ]);
      expect(parsed.questions.single.options.last.description, 'Not now');
      expect(parsed.sendsOnTap, isTrue);
    });

    test('multi-select or several questions do not send on tap', () {
      expect(
        readAgentDmQuestionCard(
          card(
            items: const [
              ['buzz-question-item', 'q1', 'Pick', '', '1', '0'],
            ],
          ),
        )!.sendsOnTap,
        isFalse,
      );
      expect(
        readAgentDmQuestionCard(
          card(
            items: const [
              ['buzz-question-item', 'q1', 'One', '', '0', '0'],
              ['buzz-question-item', 'q2', 'Two', '', '0', '1'],
            ],
          ),
        )!.sendsOnTap,
        isFalse,
      );
    });

    test('rejects any malformed part', () {
      // Five questions.
      expect(
        readAgentDmQuestionCard(
          card(
            items: [
              for (var i = 0; i < 5; i++)
                ['buzz-question-item', 'q$i', 'Q', '', '0', '1'],
            ],
            options: const [],
          ),
        ),
        isNull,
      );
      // Duplicate question id.
      expect(
        readAgentDmQuestionCard(
          card(
            items: const [
              ['buzz-question-item', 'q1', 'A', '', '0', '1'],
              ['buzz-question-item', 'q1', 'B', '', '0', '1'],
            ],
            options: const [],
          ),
        ),
        isNull,
      );
      // Option for an unknown question.
      expect(
        readAgentDmQuestionCard(
          card(
            options: const [
              ['buzz-question-option', 'q9', 'Yes', ''],
            ],
          ),
        ),
        isNull,
      );
      // Bad flag.
      expect(
        readAgentDmQuestionCard(
          card(
            items: const [
              ['buzz-question-item', 'q1', 'A', '', 'yes', '0'],
            ],
          ),
        ),
        isNull,
      );
      // Nine options.
      expect(
        readAgentDmQuestionCard(
          card(
            options: [
              for (var i = 0; i < 9; i++)
                ['buzz-question-option', 'q1', 'O$i', ''],
            ],
          ),
        ),
        isNull,
      );
      // Duplicate label.
      expect(
        readAgentDmQuestionCard(
          card(
            options: const [
              ['buzz-question-option', 'q1', 'Yes', ''],
              ['buzz-question-option', 'q1', 'Yes', ''],
            ],
          ),
        ),
        isNull,
      );
      // Nothing to tap and nothing to type.
      expect(readAgentDmQuestionCard(card(options: const [])), isNull);
      // No questions.
      expect(
        readAgentDmQuestionCard(const [
          ['buzz-question', 'ask-1'],
        ]),
        isNull,
      );
    });

    test('a question with no options is valid when Other is allowed', () {
      final parsed = readAgentDmQuestionCard(
        card(
          items: const [
            ['buzz-question-item', 'q1', 'Name it', '', '0', '1'],
          ],
          options: const [],
        ),
      )!;
      expect(parsed.questions.single.allowOther, isTrue);
      expect(parsed.questions.single.options, isEmpty);
    });
  });

  group('readAgentDmQuestionState', () {
    test('answered is answered; any other state is closed', () {
      AgentDmQuestionStateValue? state(String value) =>
          readAgentDmQuestionState([
            ['buzz-question-state', 'ask-1', value],
          ])?.state;
      expect(state('answered'), AgentDmQuestionStateValue.answered);
      expect(state('closed'), AgentDmQuestionStateValue.closed);
      expect(state('expired'), AgentDmQuestionStateValue.closed);
      expect(state(''), isNull);
    });
  });

  group('readAgentDmActions', () {
    List<String> action(
      String id, {
      String style = 'primary',
      String ref = 'r',
    }) => ['buzz-action', id, 'Label $id', 'send $id', style, ref];

    test('reads the six-element shape with its ref', () {
      final actions = readAgentDmActions([
        action('retry', ref: 'ref-1'),
        action('continue_on_claude', style: 'secondary', ref: 'ref-2'),
      ]);
      expect(actions.map((a) => a.actionId), ['retry', 'continue_on_claude']);
      expect(actions.first.primary, isTrue);
      expect(actions.last.primary, isFalse);
      expect(actions.first.ref, 'ref-1');
      expect(agentDmActionRefTags(actions.first), [
        ['buzz-action-ref', 'ref-1'],
      ]);
    });

    test('skips malformed tags and keeps at most three', () {
      final actions = readAgentDmActions([
        const ['buzz-action', 'old', 'Old', 'send', 'primary'],
        action('bad', style: 'loud'),
        action('noref', ref: ''),
        action('long', ref: 'x' * 513),
        action('a'),
        action('b'),
        action('c'),
        action('d'),
      ]);
      expect(actions.map((a) => a.actionId), ['a', 'b', 'c']);
    });

    test('reads the ref a tapped action carries', () {
      expect(
        readAgentDmActionRef(const [
          ['buzz-action-ref', 'ref-1'],
        ]),
        'ref-1',
      );
      expect(
        readAgentDmActionRef(const [
          ['buzz-action-ref', 'msg', 'retry'],
        ]),
        isNull,
      );
    });
  });

  test('readAgentDmAnswerAskId reads one buzz-answer tag', () {
    expect(
      readAgentDmAnswerAskId(const [
        ['buzz-answer', 'ask-1'],
      ]),
      'ask-1',
    );
    expect(
      readAgentDmAnswerAskId(const [
        ['buzz-answer', 'a'],
        ['buzz-answer', 'b'],
      ]),
      isNull,
    );
  });

  group('readAgentDmSurface', () {
    const id = '0B5C1F7E-8A7D-4D1E-9A51-3C2F1E0D9B88';

    test('reads one tag, lowercasing the id', () {
      final surface = readAgentDmSurface(const [
        ['buzz-surface', id, '4'],
      ]);
      expect(surface?.surfaceId, id.toLowerCase());
      expect(surface?.revision, 4);
    });

    test('refuses malformed or repeated tags', () {
      for (final tags in const [
        [
          ['buzz-surface', id],
        ],
        [
          ['buzz-surface', 'not-a-uuid', '1'],
        ],
        [
          ['buzz-surface', id, '0'],
        ],
        [
          ['buzz-surface', id, '01'],
        ],
        [
          ['buzz-surface', id, '1234567890'],
        ],
        [
          ['buzz-surface', id, '1'],
          ['buzz-surface', id, '2'],
        ],
      ]) {
        expect(readAgentDmSurface(tags), isNull, reason: '$tags');
      }
    });
  });
}
