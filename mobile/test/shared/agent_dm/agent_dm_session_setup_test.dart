import 'package:buzz/shared/agent_commands/agent_commands.dart';
import 'package:buzz/shared/agent_dm/agent_dm_delegation_client.dart';
import 'package:buzz/shared/agent_dm/agent_dm_session_setup.dart';
import 'package:buzz/shared/agent_dm/agent_dm_turn_steps.dart';
import 'package:flutter_test/flutter_test.dart';

Map<String, Object?> _panel({Object? vitals}) => {
  'current': {
    'harness': 'claude_code',
    'model': 'opus',
    'effort': 'high',
    'label': 'Claude Code · Opus 5.5 · High',
    'revision': 7,
  },
  'options': {
    'harnesses': [
      {
        'id': 'codex',
        'models': [
          {
            'id': 'gpt',
            'label': 'GPT',
            'efforts': ['low'],
          },
        ],
      },
      {
        'id': 'claude_code',
        'models': [
          {
            'id': 'opus',
            'label': 'Opus 5.5',
            'efforts': ['low', 'high'],
          },
          {
            'id': 'sonnet',
            'label': 'Sonnet 5',
            'efforts': ['low'],
          },
        ],
      },
    ],
    'effortLabels': {'low': 'Low', 'high': 'High'},
  },
  'canChange': {'model': true, 'effort': true},
  'vitals': ?vitals,
};

Map<String, Object?> _vitals() => {
  'account_usage': {
    'account_alias': 'rosspro',
    'freshness': 'fresh',
    'five_hour': {'remaining_percent': 40},
  },
  'context': {'tokens': 50000, 'window': 200000, 'percent': 25},
  'todos': {
    'total': 5,
    'completed': 2,
    'items': [
      {'status': 'completed', 'text': 'One'},
      {'status': 'in_progress', 'text': 'Two'},
    ],
  },
  'cost': {'usd': 4.1},
  'location': {'cwd': '/work/kiingo/', 'branch': 'main'},
};

Map<String, Object?> _mode(
  String id,
  String label, {
  bool available = true,
}) => {
  'id': id,
  'label': label,
  'description': '$label does this',
  'isDefault': id == 'ceiling',
  'available': available,
  'unavailableReason': available ? null : 'harness',
};

final _modes = [
  _mode('ceiling', 'Full'),
  _mode('ask', 'Ask'),
  _mode('plan', 'Plan', available: false),
];

Map<String, Object?> _modePanel({
  bool canChange = true,
  List<Object?>? modes,
}) {
  final panel = _panel();
  (panel['current'] as Map)['mode'] = 'ask';
  (panel['options'] as Map)['modes'] = modes ?? _modes;
  (panel['canChange'] as Map)['mode'] = canChange;
  return panel;
}

void main() {
  group('parseAgentDmSessionSetup', () {
    test('reads the current harness models, levels and rights', () {
      final setup = parseAgentDmSessionSetup(_panel())!;
      expect(setup.revision, 7);
      expect(setup.models.map((model) => model.id), ['opus', 'sonnet']);
      expect(setup.currentEfforts, ['low', 'high']);
      expect(setup.effortLabel('high'), 'High');
      expect(setup.canChangeModel, isTrue);
      expect(setup.vitals, isNull);
      expect(setup.shortText, 'Claude Code · Opus 5.5 · High');
    });

    test('is null for anything but that contract', () {
      expect(parseAgentDmSessionSetup(null), isNull);
      expect(parseAgentDmSessionSetup({'current': 'x'}), isNull);
      final noRevision = _panel();
      (noRevision['current'] as Map).remove('revision');
      expect(parseAgentDmSessionSetup(noRevision), isNull);
    });

    test('adds the context to the short line when it has vitals', () {
      final setup = parseAgentDmSessionSetup(_panel(vitals: _vitals()))!;
      expect(setup.shortText, 'Claude Code · Opus 5.5 · High · 25%');
    });

    test('offers only the modes the host marks available', () {
      final setup = parseAgentDmSessionSetup(_modePanel())!;
      expect(setup.mode, 'ask');
      expect(setup.canChangeMode, isTrue);
      expect(setup.availableModes.map((mode) => mode.id), ['ceiling', 'ask']);
      expect(
        setup.modeNote,
        "Ask: Ask does this. Plan isn't available on this harness.",
      );
    });

    test("no mode picks without the host's leave, or from an older host", () {
      expect(
        parseAgentDmSessionSetup(_modePanel(canChange: false))!.canChangeMode,
        isFalse,
      );
      final older = parseAgentDmSessionSetup(_panel())!;
      expect(older.modes, isEmpty);
      expect(older.canChangeMode, isFalse);
      expect(older.modeNote, isNull);
    });

    test('a terminal session says it keeps its own mode', () {
      final setup = parseAgentDmSessionSetup(
        _modePanel(
          modes: [
            {
              ..._mode('ceiling', 'Full', available: false),
              'unavailableReason': 'use_terminal_mode',
            },
          ],
        ),
      )!;
      expect(setup.availableModes, isEmpty);
      expect(
        setup.modeNote,
        'This terminal session keeps its own mode. Change it in the terminal.',
      );
    });
  });

  group('agentDmVitalsLines', () {
    test('says the vitals in the words of the other apps', () {
      final setup = parseAgentDmSessionSetup(_panel(vitals: _vitals()))!;
      expect(agentDmVitalsLines(setup.vitals!, now: DateTime(2026, 11, 2)), [
        'rosspro',
        '5h 40% left',
        'Context 25% · 50k of 200k',
        'Todos 2 of 5',
        'Two',
        r'Est. $4.10',
        'kiingo · main',
      ]);
    });

    test('marks usage that may be out of date', () {
      final vitals = _vitals();
      (vitals['account_usage'] as Map)['freshness'] = 'stale';
      final setup = parseAgentDmSessionSetup(_panel(vitals: vitals))!;
      expect(
        agentDmVitalsLines(setup.vitals!).first,
        'rosspro (may be out of date)',
      );
    });

    test('shows a reset still to come, and not one already gone', () {
      final now = DateTime(2026, 11, 2, 12);
      final vitals = _vitals();
      final usage = vitals['account_usage'] as Map;
      (usage['five_hour'] as Map)['resets_at'] = DateTime(
        2026,
        11,
        2,
        20,
      ).toUtc().toIso8601String();
      usage['seven_day'] = {
        'remaining_percent': 90,
        'resets_at': DateTime(2026, 11, 1).toUtc().toIso8601String(),
      };
      final setup = parseAgentDmSessionSetup(_panel(vitals: vitals))!;
      final lines = agentDmVitalsLines(setup.vitals!, now: now);
      expect(lines, contains('5h 40% left · resets 8:00 PM'));
      expect(lines, contains('7d 90% left'));
    });
  });

  group('parseAgentDmSetupCommand', () {
    test('reads a whole-message session command', () {
      expect(
        parseAgentDmSetupCommand('/model'),
        const AgentDmSetupCommand('model'),
      );
      expect(
        parseAgentDmSetupCommand(' /effort high '),
        const AgentDmSetupCommand('effort', 'high'),
      );
      expect(
        parseAgentDmSetupCommand('/status'),
        const AgentDmSetupCommand('status'),
      );
    });

    test('leaves everything else as a message', () {
      expect(parseAgentDmSetupCommand('what is /model'), isNull);
      expect(parseAgentDmSetupCommand('/status of the deploy'), isNull);
      expect(parseAgentDmSetupCommand('/new'), isNull);
      expect(parseAgentDmSetupCommand('/deploy now'), isNull);
    });
  });

  group('resolving a typed pick', () {
    final setup = parseAgentDmSessionSetup(_panel())!;

    test('matches an id, a label, or one partial', () {
      expect(
        resolveAgentDmModelArg(setup, 'SONNET'),
        const AgentDmSetupPick('sonnet'),
      );
      expect(
        resolveAgentDmModelArg(setup, 'Opus 5.5'),
        const AgentDmSetupPick('opus'),
      );
      expect(
        resolveAgentDmModelArg(setup, 'son'),
        const AgentDmSetupPick('sonnet'),
      );
    });

    test('"default" resets it', () {
      expect(
        resolveAgentDmEffortArg(setup, 'default'),
        const AgentDmSetupPick(null),
      );
    });

    test('several or none open the picker', () {
      expect(resolveAgentDmModelArg(setup, 'o'), isNull);
      expect(resolveAgentDmModelArg(setup, 'gpt'), isNull);
      expect(resolveAgentDmEffortArg(setup, 'max'), isNull);
    });
  });

  group('withAgentDmSetupCommands', () {
    const skill = AgentCommand.skill(
      name: 'model',
      skillId: 'skill-1',
      description: 'A skill named model.',
    );
    const research = AgentCommand.skill(
      name: 'research',
      skillId: 'skill-2',
      description: 'Research.',
    );
    const fresh = AgentCommand.session(name: 'new', description: 'Fresh.');

    test('adds nothing for an agent with no panel', () {
      expect(withAgentDmSetupCommands(const [fresh, skill], null), const [
        fresh,
        skill,
      ]);
    });

    test('leads a skill of the same name', () {
      final commands = withAgentDmSetupCommands(const [
        fresh,
        skill,
        research,
      ], parseAgentDmSessionSetup(_panel()));
      expect(commands.map((command) => command.name), [
        'new',
        'model',
        'effort',
        'status',
        'usage',
        'context',
        'cost',
        'research',
      ]);
      expect(commands[1].kind, AgentCommandKind.session);
    });

    test('offers no pick the reader may not make', () {
      final body = _panel();
      body['canChange'] = {'model': false, 'effort': false};
      final names = withAgentDmSetupCommands(
        const [],
        parseAgentDmSessionSetup(body),
      ).map((command) => command.name);
      expect(names, isNot(contains('model')));
      expect(names, isNot(contains('effort')));
      expect(names, contains('status'));
    });
  });

  test('a refused change has one plain sentence', () {
    expect(
      agentDmSetupChangeErrorSentence(
        const DelegationApiException(409, 'session_setup_revision_conflict'),
      ),
      "This session's setup just changed. Look at it again and choose.",
    );
    expect(
      agentDmSetupChangeErrorSentence(
        const DelegationApiException(422, 'session_setup_mode_not_supported'),
      ),
      "This session can't run that mode.",
    );
    expect(
      agentDmSetupChangeErrorSentence(StateError('x')),
      "Couldn't change this session's setup. Try again.",
    );
  });

  test('a stop answer maps to its outcome', () {
    expect(
      parseAgentDmStopOutcome({'state': 'stopping'}),
      AgentDmStopOutcome.stopping,
    );
    expect(
      parseAgentDmStopOutcome({'state': 'stopped'}),
      AgentDmStopOutcome.stopped,
    );
    expect(
      parseAgentDmStopOutcome({'state': 'not_running'}),
      AgentDmStopOutcome.notRunning,
    );
    expect(parseAgentDmStopOutcome(null), AgentDmStopOutcome.notRunning);
  });

  group('a reply\'s steps line (B2)', () {
    const run = '0192a6b0-0000-7000-8000-0000000000b1';
    const you = '0192a6b0-0000-7000-8000-0000000000c1';
    const reply = '0192a6b0-0000-7000-8000-0000000000d1';
    const later = '0192a6b0-0000-7000-8000-0000000000d2';
    final page = {
      'entries': [
        {'id': you, 'role': 'you', 'at': '2026-11-04T10:00:00Z', 'runId': run},
        {
          'id': reply,
          'role': 'agent',
          'at': '2026-11-04T10:00:40Z',
          'runId': run,
          'turnId': you,
          'activity': {
            'turnId': you,
            'state': 'done',
            'tools': 6,
            'durationMs': 41000,
          },
          'memory': {'turnId': you, 'label': 'Recalled 2 memories'},
        },
        {
          'id': later,
          'role': 'agent',
          'at': '2026-11-04T10:05:00Z',
          'runId': run,
        },
      ],
    };
    int ms(String iso) => DateTime.parse(iso).millisecondsSinceEpoch;

    test('a reply names its Run, or its entry when mirrored', () {
      expect(
        readAgentDmReplyKey([
          ['kiingo-mission', run.toUpperCase()],
        ], 100),
        const AgentDmReplyKey(runId: run, atMs: 100000),
      );
      expect(
        readAgentDmReplyKey([
          ['buzz-mirror', 'web', '$reply#part-2', '100'],
          ['buzz-mirror-author', 'agent', '', ''],
        ], 100),
        const AgentDmReplyKey(entryId: reply, atMs: 100000),
      );
      expect(
        readAgentDmReplyKey([
          ['buzz-mirror', 'web', reply, '100'],
          ['buzz-mirror-author', 'requester', '', ''],
        ], 100),
        isNull,
      );
      expect(
        readAgentDmReplyKey([
          ['kiingo-mission', 'not-a-uuid'],
        ], 100),
        isNull,
      );
    });

    test('the page ties a reply to the turn the other apps open', () {
      final replies = parseAgentDmChatReplies(page);
      expect(replies.map((r) => r.id), [reply, later]);
      final first = findAgentDmReply(
        replies,
        AgentDmReplyKey(runId: run, atMs: ms('2026-11-04T10:00:41Z')),
      )!;
      expect(first.turnId, you);
      expect(first.line, 'Recalled 2 memories · Used 6 tools · 41 s');
      final second = findAgentDmReply(
        replies,
        AgentDmReplyKey(runId: run, atMs: ms('2026-11-04T10:04:58Z')),
      )!;
      expect(second.turnId, later);
      expect(second.line, agentDmStepsLineUnknown);
      expect(
        findAgentDmReply(
          replies,
          const AgentDmReplyKey(entryId: later, atMs: 0),
        )?.id,
        later,
      );
      expect(
        findAgentDmReply(
          replies,
          const AgentDmReplyKey(
            runId: '0192a6b0-0000-7000-8000-0000000000ff',
            atMs: 0,
          ),
        ),
        isNull,
      );
      expect(agentDmTurnPagePath('a'), 'agents/a/chat?contract=2&limit=50');
    });

    test('steps parse as plain fields and drop bad links', () {
      final steps = parseAgentDmTurnSteps({
        'turnId': you,
        'state': 'done',
        'durationMs': 41000,
        'omitted': 2,
        'items': [
          {
            'id': 's1',
            'line': 'Ran the tests',
            'action': 'Bash',
            'state': 'failed',
            'args': 'pnpm test',
            'link': {'url': 'javascript:alert(1)'},
          },
          {'id': 's2', 'type': 'reasoning', 'text': 'Thinking\nabout it'},
          {'id': 's3'},
          {
            'id': 's4',
            'type': 'note',
            'line': 'Opened the doc',
            'link': {'url': 'https://example.com/doc', 'title': 'Doc'},
          },
        ],
      })!;
      expect(steps.omitted, 2);
      expect(steps.items.map((step) => step.id), ['s1', 's2', 's4']);
      expect(steps.items[0].action, 'Bash');
      expect(steps.items[0].state, AgentDmStepState.failed);
      expect(steps.items[0].linkUrl, isNull);
      expect(steps.items[1].line, 'Thinking about it');
      expect(steps.items[2].linkUrl.toString(), 'https://example.com/doc');
      expect(parseAgentDmTurnSteps({'turnId': 'x'}), isNull);
      expect(agentDmStepsDuration(185000), '3 min 5 s');
      expect(agentDmStepsDuration(3720000), '1 h 2 min');
      expect(agentDmActivityLine({'tools': 1}), 'Used 1 tool');
    });
  });
}
