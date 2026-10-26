import 'dart:convert';
import 'dart:io';

import 'package:buzz/shared/agent_dm/agent_dm_markers.dart';
import 'package:buzz/shared/agent_dm/agent_dm_mirror_display.dart';
import 'package:buzz/shared/agent_dm/agent_dm_you_decompositions.dart';
import 'package:flutter_test/flutter_test.dart';

// The same vectors drive desktop's rule
// (desktop/src/features/agent-dm/lib/mirrorDisplay.test.mjs), so the two
// clients cannot drift.
final Map<String, dynamic> _vectors =
    jsonDecode(File('../test-fixtures/mirror-display.json').readAsStringSync())
        as Map<String, dynamic>;

List<List<String>> _tags(Object? raw) => [
  for (final tag in raw! as List<dynamic>)
    [for (final part in tag as List<dynamic>) part as String],
];

Map<String, Object?>? _project(AgentDmMirrorDisplay? display, String content) =>
    display == null
    ? null
    : {
        'authorPubkey': display.authorPubkey,
        'authorName': display.authorName,
        'relayedByPubkey': display.relayedByPubkey,
        'relayedByName': display.relayedByName,
        'surfaceLabel': display.surfaceLabel,
        'relayLine': display.relayLine,
        'relayed': display.relayed,
        'plainText': display.plainText(content),
      };

void main() {
  final names = (_vectors['names'] as Map<String, dynamic>)
      .cast<String, String>();
  final cases = (_vectors['cases'] as List<dynamic>)
      .cast<Map<String, dynamic>>();

  test('the shared mirror display vectors hold', () {
    expect(cases, isNotEmpty);
    for (final vector in cases) {
      final event = vector['event'] as Map<String, dynamic>;
      final channel = vector['channel'] as Map<String, dynamic>?;
      final display = agentDmMirrorDisplay(
        kind: event['kind'] as int,
        signerPubkey: event['pubkey'] as String,
        tags: _tags(event['tags']),
        isDm: channel?['isDm'] as bool? ?? false,
        memberPubkeys: [
          for (final pubkey
              in channel?['memberPubkeys'] as List<dynamic>? ?? const [])
            pubkey as String,
        ],
        names: (pubkey) => names[pubkey] ?? pubkey,
        signerIsAgent: vector['signerIsAgent'] as bool,
        viewerPubkey: vector['viewer'] as String?,
      );
      expect(
        _project(display, vector['content'] as String),
        vector['expected'],
        reason: vector['name'] as String,
      );
    }
  });

  test('surface labels cover the Kiingo surfaces and keep the badges', () {
    expect(agentDmMirrorSurfaceLabel('tasks'), 'Kiingo Tasks');
    expect(agentDmMirrorSurfaceLabel('companion'), 'the Companion');
    expect(agentDmMirrorSurfaceLabel('ask'), 'Kiingo Ask');
    expect(agentDmMirrorSurfaceLabel('fax'), 'fax');
    final mirror = readAgentDmMirror(const [
      ['buzz-mirror', 'tasks', 't1', '1'],
      ['buzz-mirror-author', 'requester', '', ''],
    ])!;
    expect(mirror.badgeLabel, 'via Kiingo Tasks');
    final email = readAgentDmMirror(const [
      ['buzz-mirror', 'email', 'm1', '1'],
      ['buzz-mirror-author', 'agent', '', ''],
    ])!;
    expect(email.badgeLabel, 'via email');
  });

  test('copy text uses the relayed form for a mirror only', () {
    const agent =
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const alex =
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    final display = agentDmMirrorDisplay(
      kind: agentDmQuietKind,
      signerPubkey: agent,
      tags: const [
        ['buzz-mirror', 'companion', 'c1', '1'],
        ['buzz-mirror-author', 'requester', alex, ''],
      ],
      isDm: true,
      memberPubkeys: const [agent, alex],
      names: (pubkey) => pubkey == alex ? 'Alex' : 'Agent',
      signerIsAgent: true,
    );
    expect(
      agentDmMirrorCopyText(display, 'Book the room'),
      'Alex (via the Companion, relayed by Agent): Book the room',
    );
    expect(agentDmMirrorCopyText(null, 'Book the room'), 'Book the room');
  });

  test('a malformed author tag reads as an unattributed requester', () {
    const mirror = ['buzz-mirror', 'tasks', 't1', '1'];
    for (final tags in const [
      [mirror],
      [
        mirror,
        ['buzz-mirror-author', 'owner', '', ''],
      ],
      [
        mirror,
        ['buzz-mirror-author', 'agent', 'not-a-key', ''],
      ],
      [
        mirror,
        ['buzz-mirror-author', 'agent', '', '', 'extra'],
      ],
      [
        mirror,
        ['buzz-mirror-author', 'agent', '', ''],
        ['buzz-mirror-author', 'agent', '', ''],
      ],
    ]) {
      final parsed = readAgentDmMirror(tags);
      expect(parsed?.role, AgentDmMirrorRole.requester, reason: '$tags');
      expect(parsed?.authorPubkey, '', reason: '$tags');
    }
    expect(
      readAgentDmMirror(const [
        ['buzz-mirror-author', 'requester', '', ''],
      ]),
      isNull,
    );
    expect(
      readAgentDmMirror(const [
        ['buzz-mirror', 'email', 'm1', '1'],
        ['buzz-mirror-author', 'agent', '', ''],
        ['subject', 'one'],
        ['subject', 'two'],
      ])?.subject,
      isNull,
    );
  });

  test('only a name that reads as You is refused', () {
    for (final name in [
      'You',
      ' you ',
      '\u04aeou',
      'Yo\u200bu',
      'You.',
      '(You)',
      '\uff39\uff4f\uff55',
      'Y0u',
      'Y\u0332o\u0332u\u0332',
      '\u24ce\u24c4\u24ca',
      '\u24e8\u24de\u24e4',
      '\u02b8\u1d52\u1d58',
      'Y\u00f3u',
      'Yo\u0301u',
      '\u00dd\u00d6\u00dc',
      '\u00ff\u014d\u016b',
    ]) {
      expect(agentDmNameReadsAsYou(name), isTrue, reason: name);
    }
    for (final name in [
      'Young',
      'Yours truly',
      'Agent You',
      'Yo',
      '',
      'Yo\u00f9 r',
    ]) {
      expect(agentDmNameReadsAsYou(name), isFalse, reason: name);
    }
  });

  test('the NFKD stand-in table keeps its generated size', () {
    // Regenerate with scripts/generate-agent-dm-you-decompositions.py. A
    // Unicode version change that moves this count must be reviewed, and the
    // shared vectors rerun on every client.
    expect(agentDmYouDecompositions.length, 340);
    expect(agentDmYouDecompositions[0x00f3], 0x6f);
    expect(agentDmYouDecompositions[0x00fd], 0x79);
    expect(agentDmYouDecompositions[0x00fc], 0x75);
  });
}
