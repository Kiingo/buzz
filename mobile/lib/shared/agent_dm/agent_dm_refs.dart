import 'package:flutter/foundation.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../agent_commands/agent_commands.dart';
import '../agent_details/agent_summary.dart';
import 'agent_dm_delegation_client.dart';

// Task and project references in a 1:1 agent DM (BUZZPARITY B5). "/task" and
// "/project" open a search of what the reader can read (the host's
// `agents/<id>/chat/refs` on the Buzz mount, the signer's own read access).
// A pick puts its label in the draft, and the send carries one
// `["buzz-ref", type, id]` tag for each label still in the text. The tag is
// only a request: Kiingo checks each again, for the author's own message in
// a private DM, and the agent gets the ones that resolve. No count limit.

final _uuid = RegExp(
  r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
  caseSensitive: false,
);

/// The "/" rows; offered anywhere in the message, not only at its start.
const agentDmRefTaskCommand = AgentCommand.session(
  name: 'task',
  description: 'Reference a task',
);
const agentDmRefProjectCommand = AgentCommand.session(
  name: 'project',
  description: 'Reference a project',
);
const agentDmRefCommands = [agentDmRefTaskCommand, agentDmRefProjectCommand];

/// `task` or `project` for one of these very rows, else null: a session
/// command or skill of the same name never opens the picker.
String? agentDmRefTypeFor(AgentCommand command) =>
    identical(command, agentDmRefTaskCommand)
    ? 'task'
    : identical(command, agentDmRefProjectCommand)
    ? 'project'
    : null;

/// [commands] with the reference rows after them, when the agent is hosted.
List<AgentCommand> withAgentDmRefCommands(
  List<AgentCommand> commands, {
  required bool hosted,
}) => hosted ? [...commands, ...agentDmRefCommands] : commands;

@immutable
class AgentDmRef {
  const AgentDmRef({
    required this.type,
    required this.id,
    required this.title,
    this.subtitle,
  });

  /// `task` or `project`.
  final String type;
  final String id;
  final String title;

  /// "In your queue with Scout" for a task in the agent's queue.
  final String? subtitle;

  /// What a pick puts in the draft.
  String get label {
    final shown = title.replaceAll(RegExp(r'\s+'), ' ').trim();
    return '$type: ${shown.isEmpty ? 'untitled' : shown}';
  }

  @override
  bool operator ==(Object other) =>
      other is AgentDmRef &&
      other.type == type &&
      other.id == id &&
      other.title == title &&
      other.subtitle == subtitle;

  @override
  int get hashCode => Object.hash(type, id, title, subtitle);
}

/// The host's `{ results }`: each well-formed task or project row, in order.
List<AgentDmRef>? parseAgentDmRefs(Object? body) {
  final results = body is Map ? body['results'] : null;
  if (results is! List) return null;
  return [
    for (final raw in results)
      if (raw is Map)
        if (raw['type'] case final String type
            when type == 'task' || type == 'project')
          if (raw['id'] case final String id when _uuid.hasMatch(id))
            if (raw['title'] case final String title)
              AgentDmRef(
                type: type,
                id: id.toLowerCase(),
                title: title,
                subtitle: raw['subtitle'] is String
                    ? raw['subtitle'] as String
                    : null,
              ),
  ];
}

String agentDmRefsPath(String agentId, String type, String query) {
  final q = query.trim();
  return 'agents/$agentId/chat/refs?types=$type'
      '${q.isEmpty ? '' : '&q=${Uri.encodeComponent(q)}'}&limit=20';
}

/// The tags for the picks whose label is still in [text]: each pick once, in
/// the order picked. A label the person deleted sends nothing.
List<List<String>> agentDmRefTags(List<AgentDmRef> picks, String text) {
  final seen = <String>{};
  return [
    for (final pick in picks)
      if (text.contains(pick.label) && seen.add('${pick.type}:${pick.id}'))
        ['buzz-ref', pick.type, pick.id],
  ];
}

/// A failed search in plain words.
String agentDmRefsErrorSentence(Object error) =>
    error is DelegationApiException && error.code == 'agent_not_hosted'
    ? 'This agent has no host, so there is nothing to reference here.'
    : "Couldn't search right now. Try again.";

/// One search. Throws on a failed read; `ref.invalidate` searches again.
final agentDmRefSearchProvider = FutureProvider.autoDispose
    .family<
      List<AgentDmRef>,
      ({String agentPubkey, String type, String query})
    >((ref, key) async {
      final client = ref.watch(delegationClientProvider);
      final summary = await ref.read(
        agentSummaryProvider(key.agentPubkey.toLowerCase()).future,
      );
      final agentId = summary?.agentId;
      if (client == null || agentId == null || !_uuid.hasMatch(agentId)) {
        throw const DelegationApiException(null, 'agent_not_hosted');
      }
      final found = parseAgentDmRefs(
        await client.send(
          'GET',
          agentDmRefsPath(agentId.toLowerCase(), key.type, key.query),
        ),
      );
      if (found == null) {
        throw const DelegationApiException(null, 'response_malformed');
      }
      return found;
    });
