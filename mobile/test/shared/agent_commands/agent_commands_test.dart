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
    test('opens only inside the first word after a leading slash', () {
      expect(findAgentCommandQuery('/', 1)?.query, '');
      expect(findAgentCommandQuery('/Res', 4)?.query, 'res');
      expect(findAgentCommandQuery('/research topic', 15), isNull);
      expect(findAgentCommandQuery('hi /res', 7), isNull);
      expect(findAgentCommandQuery('', 0), isNull);
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
    expect(filterAgentCommands(commands, ''), commands);
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

    test('a typed name, another word or long args send no tag', () {
      expect(agentSkillInvocationTags('/research go', const {}), isEmpty);
      expect(
        agentSkillInvocationTags('please /research', {'research': research}),
        isEmpty,
      );
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
}
