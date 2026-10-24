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

  test('findGroupAgentCommandQuery opens at any word start', () {
    final open = findGroupAgentCommandQuery('ask @Scout to /re', 17)!;
    expect(open.query, 're');
    expect(open.tokenStart, 14);
    expect(open.tokenEnd, 17);
    expect(open.prefix, 'ask @Scout to ');
    expect(findGroupAgentCommandQuery('hi /', 4)!.prefix, 'hi ');
    expect(findGroupAgentCommandQuery('see https://x.io/re', 19), isNull);
    expect(findGroupAgentCommandQuery('me@x.io/re', 10), isNull);
  });

  test('mentionsSomeone: an @ that opens a word', () {
    expect(mentionsSomeone('@Scout '), isTrue);
    expect(mentionsSomeone('ask @Scout to '), isTrue);
    expect(mentionsSomeone('(@Scout) '), isTrue);
    expect(mentionsSomeone('hi '), isFalse);
    expect(mentionsSomeone('me@example.com '), isFalse);
    expect(mentionsSomeone(''), isFalse);
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
    // Picked mid-message: the whole message, mention included, is input.
    expect(
      groupAgentSkillInvocationTags('ask @Scout to /review the PR', {
        'review': review,
      }),
      [
        ['buzz-skill', 'skill-review', 'ask @Scout to the PR'],
      ],
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

  test('narrowGroupCommandTarget drops agents with nothing to offer', () {
    final choose = (agent: null, choices: [_a, _b, _c]);
    GroupCommandListState Function(String) states(
      Map<String, GroupCommandListState> known,
    ) =>
        (pubkey) => known[pubkey] ?? GroupCommandListState.unknown;
    expect(narrowGroupCommandTarget(choose, states({}))?.choices, [_a, _b, _c]);
    expect(
      narrowGroupCommandTarget(
        choose,
        states({_b: GroupCommandListState.empty}),
      )?.choices,
      [_a, _c],
    );
    final only = narrowGroupCommandTarget(
      choose,
      states({
        _a: GroupCommandListState.some,
        _b: GroupCommandListState.empty,
        _c: GroupCommandListState.empty,
      }),
    );
    expect(only?.agent, _a);
    expect(only?.choices, isEmpty);
    // The one left is still loading: keep offering it.
    expect(
      narrowGroupCommandTarget(
        choose,
        states({
          _b: GroupCommandListState.empty,
          _c: GroupCommandListState.empty,
        }),
      )?.choices,
      [_a],
    );
    expect(
      narrowGroupCommandTarget(
        choose,
        states({
          _a: GroupCommandListState.empty,
          _b: GroupCommandListState.empty,
          _c: GroupCommandListState.empty,
        }),
      ),
      isNull,
    );
  });
}
