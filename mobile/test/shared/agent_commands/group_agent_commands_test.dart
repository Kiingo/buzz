import 'package:buzz/shared/agent_commands/agent_commands.dart';
import 'package:buzz/shared/agent_commands/group_agent_commands.dart';
import 'package:flutter_test/flutter_test.dart';

final _a = 'a' * 64;
final _b = 'b' * 64;
final _c = 'c' * 64;

void main() {
  test('groupCommandTokenStart: at the start or after a leading mention', () {
    expect(groupCommandTokenStart('/rev'), 0);
    expect(groupCommandTokenStart('@Scout /rev'), 7);
    expect(groupCommandTokenStart('@Scout Bot /rev'), 11);
    expect(groupCommandTokenStart('hi /rev'), isNull);
    expect(groupCommandTokenStart('@Scout\nnext /rev'), isNull);
    expect(groupCommandTokenStart('@ /rev'), isNull);
  });

  test('findGroupAgentCommandQuery reads the token after the mention', () {
    final open = findGroupAgentCommandQuery('@Scout /Re', 10)!;
    expect(open.query, 're');
    expect(open.tokenStart, 7);
    expect(open.prefix, '@Scout ');
    expect(findGroupAgentCommandQuery('/', 1)!.prefix, '');
    // Arguments are being typed, or the caret is in the mention.
    expect(findGroupAgentCommandQuery('@Scout /review x', 16), isNull);
    expect(findGroupAgentCommandQuery('@Scout /re', 3), isNull);
  });

  test('resolveGroupCommandTarget: the mention, else the only agent', () {
    expect(
      resolveGroupCommandTarget(
        hasPrefix: true,
        prefixAgent: _b,
        channelAgents: [_a, _c],
      )?.agent,
      _b,
    );
    // A mention of someone who is not an agent: no popup.
    expect(
      resolveGroupCommandTarget(
        hasPrefix: true,
        prefixAgent: null,
        channelAgents: [_a],
      ),
      isNull,
    );
    expect(
      resolveGroupCommandTarget(
        hasPrefix: false,
        prefixAgent: null,
        channelAgents: [_a.toUpperCase(), _a],
      )?.agent,
      _a,
    );
    final choose = resolveGroupCommandTarget(
      hasPrefix: false,
      prefixAgent: null,
      channelAgents: [_b, _c],
    )!;
    expect(choose.agent, isNull);
    expect(choose.choices, [_b, _c]);
    expect(
      resolveGroupCommandTarget(
        hasPrefix: false,
        prefixAgent: null,
        channelAgents: const [],
      ),
      isNull,
    );
    final many = [for (var i = 0; i < 30; i++) i.toRadixString(16) * 64];
    expect(
      resolveGroupCommandTarget(
        hasPrefix: false,
        prefixAgent: null,
        channelAgents: many,
      )!.choices,
      hasLength(maxGroupCommandAgentChoices),
    );
  });

  test('groupAgentSkillInvocationTags keeps the typed args', () {
    const review = AgentCommand.skill(name: 'review', skillId: 'skill-review');
    expect(
      groupAgentSkillInvocationTags('@Scout /review the PR', {
        'review': review,
      }),
      [
        ['buzz-skill', 'skill-review', 'the PR'],
      ],
    );
    expect(
      groupAgentSkillInvocationTags('please /review', {'review': review}),
      isEmpty,
    );
    expect(
      groupAgentSkillInvocationTags('@Scout /review x', const {}),
      isEmpty,
    );
  });

  test('agent rows sort first and carry their key', () {
    final commands = filterAgentCommands([
      const AgentCommand.skill(name: 'review', skillId: 's1'),
      AgentCommand.agent(name: 'Scout', agentPubkey: _a),
    ], '');
    expect(commands.first.kind, AgentCommandKind.agent);
    expect(commands.first.agentPubkey, _a);
    expect(commands.first.section, AgentCommandSection.agents);
  });
}
