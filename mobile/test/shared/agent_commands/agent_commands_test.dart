import 'package:buzz/shared/agent_commands/agent_commands.dart';
import 'package:flutter_test/flutter_test.dart';

const _agent =
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

Map<String, Object?> _body(List<Object?> commands) => {
  'contract_version': 1,
  'agent_id': '00000000-0000-4000-8000-000000000001',
  'agent_public_key': _agent,
  'commands': commands,
};

void main() {
  group('parseAgentCommands', () {
    test('reads session commands and skills', () {
      final commands = parseAgentCommands(
        _body([
          {
            'kind': 'session',
            'name': 'new',
            'description': 'Start a new session.',
            'usage': '/new',
          },
          {
            'kind': 'skill',
            'name': 'research',
            'skill_id': 'skill-1',
            'description': 'Research a topic.',
            'argument_hint': '<topic>',
          },
        ]),
        agentPublicKey: _agent,
      );
      expect(commands, [
        const AgentCommand.session(
          name: 'new',
          description: 'Start a new session.',
        ),
        const AgentCommand.skill(
          name: 'research',
          skillId: 'skill-1',
          description: 'Research a topic.',
          argumentHint: '<topic>',
        ),
      ]);
    });

    test('rejects another contract or another agent', () {
      expect(
        parseAgentCommands({'contract_version': 2}, agentPublicKey: _agent),
        isNull,
      );
      expect(
        parseAgentCommands(_body(const []), agentPublicKey: 'b' * 64),
        isNull,
      );
    });

    test('drops malformed rows and unknown session names', () {
      final commands = parseAgentCommands(
        _body([
          {'kind': 'session', 'name': 'delete'},
          {'kind': 'skill', 'name': 'x', 'skill_id': 'bad id'},
          {'kind': 'skill', 'name': 'two words', 'skill_id': 'a'},
          'nope',
        ]),
        agentPublicKey: _agent,
      );
      expect(commands, isEmpty);
    });
  });

  group('findAgentCommandQuery', () {
    test('opens inside a "/" token at any word start', () {
      expect(findAgentCommandQuery('/', 1)?.query, '');
      expect(findAgentCommandQuery('/Res', 4)?.query, 'res');
      expect(findAgentCommandQuery('/research topic', 15), isNull);
      expect(findAgentCommandQuery('', 0), isNull);
      final mid = findAgentCommandQuery('hi /res', 7)!;
      expect(mid.query, 'res');
      expect(mid.tokenStart, 3);
      expect(mid.tokenEnd, 7);
      expect(findAgentCommandQuery('line\n/', 6)?.tokenStart, 5);
      expect(findAgentCommandQuery('see (/re', 8)?.tokenStart, 5);
      // Mid-message before more text: a pick replaces only the token.
      final before = findAgentCommandQuery('hi /re there', 6)!;
      expect(before.tokenStart, 3);
      expect(before.tokenEnd, 6);
    });

    test('never opens inside a word, URL, email address or path', () {
      expect(findAgentCommandQuery('a/res', 5), isNull);
      expect(findAgentCommandQuery('https://example.com/res', 23), isNull);
      expect(findAgentCommandQuery('see https://x.io/', 17), isNull);
      expect(findAgentCommandQuery('me@example.com/res', 18), isNull);
      expect(findAgentCommandQuery('open ~/res', 10), isNull);
      expect(findAgentCommandQuery('open ./res', 10), isNull);
      expect(findAgentCommandQuery('open /usr/bin', 13), isNull);
      expect(
        agentCommandTokens(
          'a /x b/y /z',
        ).map((token) => (token.start, token.end, token.name)),
        [(2, 4, 'x'), (9, 11, 'z')],
      );
    });
  });

  test('filterAgentCommands puts prefix matches first', () {
    const commands = [
      AgentCommand.skill(name: 'deep-research', skillId: 'a'),
      AgentCommand.skill(name: 'research', skillId: 'b'),
      AgentCommand.session(name: 'sessions', description: ''),
    ];
    expect(filterAgentCommands(commands, 'res').map((c) => c.name), [
      'research',
      'deep-research',
    ]);
    expect(filterAgentCommands(commands, '').map((c) => c.name), [
      'sessions',
      'deep-research',
      'research',
    ]);
  });

  group('registry skills', () {
    test('parse keeps the source and display name', () {
      final commands = parseAgentCommands(
        _body([
          {
            'kind': 'skill',
            'name': 'deep-research',
            'skill_id': 'reg-1',
            'description': 'Research a topic.',
            'argument_hint': null,
            'source': 'registry',
            'display_name': 'Deep Research',
          },
        ]),
        agentPublicKey: _agent,
      );
      expect(commands, [
        const AgentCommand.skill(
          name: 'deep-research',
          skillId: 'reg-1',
          description: 'Research a topic.',
          source: AgentSkillSource.registry,
          displayName: 'Deep Research',
        ),
      ]);
      expect(commands!.single.section, AgentCommandSection.skills);
    });

    test('sections order the list; descriptions match from three letters', () {
      const commands = [
        AgentCommand.skill(
          name: 'notes',
          skillId: 'r1',
          description: 'Write review notes',
          source: AgentSkillSource.registry,
        ),
        AgentCommand.skill(name: 'review', skillId: 'i1'),
        AgentCommand.session(name: 'new', description: 'Start fresh'),
      ];
      expect(filterAgentCommands(commands, '').map((c) => c.name), [
        'new',
        'review',
        'notes',
      ]);
      expect(filterAgentCommands(commands, 'review').map((c) => c.name), [
        'review',
        'notes',
      ]);
      expect(filterAgentCommands(commands, 're').map((c) => c.name), [
        'review',
      ]);
      expect(filterAgentCommands(commands, 'rvw').map((c) => c.name), [
        'review',
      ]);
    });
  });

  group('agentSkillInvocationTags', () {
    const research = AgentCommand.skill(name: 'research', skillId: 'skill-1');

    test('tags a message that starts with a picked skill', () {
      expect(
        agentSkillInvocationTags('/research  Q3 revenue ', {
          'research': research,
        }),
        [
          ['buzz-skill', 'skill-1', 'Q3 revenue'],
        ],
      );
      expect(agentSkillInvocationTags('/research', {'research': research}), [
        ['buzz-skill', 'skill-1', ''],
      ]);
    });

    test('a skill picked mid-message takes the whole message as input', () {
      expect(
        agentSkillInvocationTags('please /research Q3 revenue', {
          'research': research,
        }),
        [
          ['buzz-skill', 'skill-1', 'please Q3 revenue'],
        ],
      );
      expect(
        agentSkillInvocationTags('please /research', {'research': research}),
        [
          ['buzz-skill', 'skill-1', 'please'],
        ],
      );
      // A URL in the message is input, never a token.
      expect(
        agentSkillInvocationTags('/research https://x.io/a/b', {
          'research': research,
        }),
        [
          ['buzz-skill', 'skill-1', 'https://x.io/a/b'],
        ],
      );
    });

    test('one skill per message: the last picked token counts', () {
      const review = AgentCommand.skill(name: 'review', skillId: 'skill-2');
      expect(
        agentSkillInvocationTags('/research a then /review b', {
          'research': research,
          'review': review,
        }),
        [
          ['buzz-skill', 'skill-2', '/research a then b'],
        ],
      );
    });

    test('a typed name or long args send no tag', () {
      expect(agentSkillInvocationTags('/research go', const {}), isEmpty);
      expect(agentSkillInvocationTags('I ran /research', const {}), isEmpty);
      expect(
        agentSkillInvocationTags('/research ${'x' * 4001}', {
          'research': research,
        }),
        isEmpty,
      );
      expect(
        agentSkillInvocationTags('/new', {
          'new': const AgentCommand.session(name: 'new', description: ''),
        }),
        isEmpty,
      );
    });
  });

  test('a cut-short body is flagged and searches are normalized', () {
    expect(agentCommandsBodyTruncated({'truncated': true}), isTrue);
    expect(agentCommandsBodyTruncated({'truncated': 'yes'}), isFalse);
    expect(agentCommandsBodyTruncated(null), isFalse);
    expect(normalizeAgentCommandQuery('  Kiingo-FR '), 'kiingo-fr');
    expect(normalizeAgentCommandQuery('x' * 100).length, 64);
  });

  test('the popup lists every match, not just a first screenful', () {
    final many = [
      for (var index = 0; index < 300; index++)
        AgentCommand.skill(
          name: 'skill-${index.toString().padLeft(3, '0')}',
          skillId: 'sk-$index',
          source: AgentSkillSource.registry,
        ),
    ];
    expect(filterAgentCommands(many, '').length, 300);
    expect(
      mergeAgentCommands(
        [many.first],
        [many.first, many[1]],
      ).map((command) => command.name),
      ['skill-000', 'skill-001'],
    );
  });
}
