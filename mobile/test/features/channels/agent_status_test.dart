import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:buzz/features/channels/agent_status_row.dart';
import 'package:buzz/features/channels/timeline_message.dart';
import 'package:buzz/shared/profile/user_cache_provider.dart';
import 'package:buzz/shared/profile/user_profile.dart';
import 'package:buzz/shared/relay/relay.dart';

import '../../helpers/widget_helpers.dart';

const root = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const channel = 'a0000000-0000-4000-8000-000000000001';
const actor =
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

NostrEvent status({
  Map<String, Object>? extraPayload,
  List<List<String>>? tags,
  int kind = EventKind.agentStatus,
}) => NostrEvent(
  id: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  pubkey: actor,
  createdAt: 100,
  kind: kind,
  sig: '',
  tags:
      tags ??
      [
        ['h', channel],
        ['e', root, '', 'reply'],
        ['d', 'fence'],
      ],
  content: jsonEncode({
    'version': 1,
    'receipt_id': 'd0000000-0000-4000-8000-000000000001',
    'state': 'cancelled',
    'text': 'Cancelled by the user.',
    ...?extraPayload,
  }),
);

class _StatusUserCache extends UserCacheNotifier {
  @override
  Map<String, UserProfile> build() => {
    actor: const UserProfile(pubkey: actor, displayName: 'Agent'),
  };
}

void main() {
  test(
    'operational status is attributed to signer and remains inside its thread',
    () {
      final messages = formatTimeline([status()]);
      expect(messages, hasLength(1));
      expect(messages.single.isSystem, true);
      expect(messages.single.parentId, root);
      expect(messages.single.rootId, root);
      expect(messages.single.systemEvent?.actorPubkey, actor);
      expect(
        messages.single.systemEvent?.describe((_) => 'Agent'),
        'Agent · System status: Cancelled by the user.',
      );
      expect(buildMainTimelineEntries(messages), isEmpty);
      expect(
        EventKind.channelTimelineContentKinds,
        contains(EventKind.agentStatus),
      );
      expect(
        EventKind.channelMessageEventKinds,
        isNot(contains(EventKind.agentStatus)),
      );
    },
  );

  test(
    'spoofed actor, root-channel status, broadcasts and chat lookalikes fail closed',
    () {
      for (final event in [
        status(kind: 9),
        status(kind: 40099),
        status(
          tags: [
            ['h', channel],
          ],
        ),
        status(extraPayload: {'actor': 'relay'}),
        status(extraPayload: {'state': 'completed'}),
        status(
          tags: [
            ...status().tags,
            ['broadcast', '1'],
          ],
        ),
      ]) {
        expect(SystemEvent.fromAgentStatus(event), isNull);
        if (event.kind == EventKind.agentStatus) {
          expect(formatTimeline([event]), isEmpty);
        }
      }
    },
  );

  testWidgets(
    'status widget shows signer-attributed plain text without chat actions',
    (tester) async {
      final message = formatTimeline([status()]).single;
      await tester.pumpWidget(
        WidgetHelpers.testable(
          overrides: [userCacheProvider.overrideWith(_StatusUserCache.new)],
          child: AgentStatusRow(message: message),
        ),
      );
      expect(
        find.text('Agent · System status: Cancelled by the user.'),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('agent-operational-status')),
        findsOneWidget,
      );
      final row = find.byType(AgentStatusRow);
      for (final action in [
        find.byType(IconButton),
        find.byType(TextButton),
        find.byType(InkWell),
        find.byType(GestureDetector),
      ]) {
        expect(find.descendant(of: row, matching: action), findsNothing);
      }
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('status widget hides root-channel status and ordinary chat', (
    tester,
  ) async {
    final event = status();
    final rootStatus = TimelineMessage(
      id: event.id,
      pubkey: event.pubkey,
      createdAt: event.createdAt,
      content: event.content,
      isSystem: true,
      systemEvent: SystemEvent.fromAgentStatus(event),
    );
    for (final message in [
      rootStatus,
      formatTimeline([status(kind: 9)]).single,
    ]) {
      await tester.pumpWidget(
        WidgetHelpers.testable(
          overrides: [userCacheProvider.overrideWith(_StatusUserCache.new)],
          child: AgentStatusRow(message: message),
        ),
      );
      expect(
        find.byKey(const ValueKey('agent-operational-status')),
        findsNothing,
      );
      expect(find.textContaining('System status'), findsNothing);
      expect(tester.takeException(), isNull);
    }
  });
}
