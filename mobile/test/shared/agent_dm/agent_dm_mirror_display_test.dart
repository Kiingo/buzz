import 'dart:convert';
import 'dart:io';

import 'package:buzz/shared/agent_dm/agent_dm_markers.dart';
import 'package:buzz/shared/agent_dm/agent_dm_mirror_display.dart';
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
    expect(agentDmMirrorSurfaceLabel('companion'), 'Kiingo Companion');
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
    const ross =
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    final display = agentDmMirrorDisplay(
      kind: agentDmQuietKind,
      signerPubkey: agent,
      tags: const [
        ['buzz-mirror', 'companion', 'c1', '1'],
        ['buzz-mirror-author', 'requester', ross, ''],
      ],
      isDm: true,
      memberPubkeys: const [agent, ross],
      names: (pubkey) => pubkey == ross ? 'Ross' : 'Juniper',
      signerIsAgent: true,
    );
    expect(
      agentDmMirrorCopyText(display, 'Book the room'),
      'Ross (via Kiingo Companion, relayed by Juniper): Book the room',
    );
    expect(agentDmMirrorCopyText(null, 'Book the room'), 'Book the room');
  });
}
