import 'package:buzz/shared/agent_commands/agent_commands.dart';
import 'package:buzz/shared/agent_dm/agent_dm_delegation_client.dart';
import 'package:buzz/shared/agent_dm/agent_dm_session_setup.dart';
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
}
