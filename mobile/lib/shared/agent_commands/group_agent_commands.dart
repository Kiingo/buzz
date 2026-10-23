import 'agent_commands.dart';

/// The "/" popup in a channel or thread. Unlike a 1:1 DM the conversation
/// has no single agent, so the command may follow a leading mention of the
/// agent it is for (`@Scout /rev`), and the popup needs a target agent.

/// Agents offered to choose from when the target is ambiguous.
const maxGroupCommandAgentChoices = 20;

/// Where the `/` of a command starts in [text]: at the very start, or right
/// after a leading `@…` mention on the first line. Null otherwise.
int? groupCommandTokenStart(String text) {
  if (text.startsWith('/')) return 0;
  if (!text.startsWith('@')) return null;
  final at = text.indexOf(' /');
  if (at < 2) return null;
  return text.substring(0, at).contains('\n') ? null : at + 1;
}

/// An open "/" query in a channel or thread.
class GroupAgentCommandQuery {
  const GroupAgentCommandQuery({
    required this.query,
    required this.tokenStart,
    required this.prefix,
  });

  /// What follows the `/`, lowercased.
  final String query;

  /// Offset of the `/`.
  final int tokenStart;

  /// The text before the `/` (empty, or `@Name `).
  final String prefix;
}

/// The "/" query at [cursor] in [text], or `null` when none is open.
GroupAgentCommandQuery? findGroupAgentCommandQuery(String text, int cursor) {
  final start = groupCommandTokenStart(text);
  if (start == null || cursor <= start) return null;
  final open = findAgentCommandQuery(text.substring(start), cursor - start);
  if (open == null) return null;
  return GroupAgentCommandQuery(
    query: open.query,
    tokenStart: start,
    prefix: text.substring(0, start),
  );
}

/// Who a channel's "/" is for: one agent, or several to choose from.
typedef GroupCommandTarget = ({String? agent, List<String> choices});

/// The agent a "/" is for: the agent mentioned before it, else the
/// conversation's only agent; several agents are offered as a choice. A
/// mention of someone who is not an agent, or no agent at all, is no popup.
GroupCommandTarget? resolveGroupCommandTarget({
  required bool hasPrefix,
  required String? prefixAgent,
  required List<String> channelAgents,
}) {
  if (hasPrefix) {
    return prefixAgent == null ? null : (agent: prefixAgent, choices: const []);
  }
  final agents = {for (final pubkey in channelAgents) pubkey.toLowerCase()};
  if (agents.isEmpty) return null;
  if (agents.length == 1) return (agent: agents.single, choices: const []);
  return (
    agent: null,
    choices: agents.take(maxGroupCommandAgentChoices).toList(),
  );
}

/// The `buzz-skill` tag for a channel or thread message
/// (`[@Name ]/skill args`) when the skill was picked from the popup.
List<List<String>> groupAgentSkillInvocationTags(
  String text,
  Map<String, AgentCommand> chosen,
) {
  final trimmed = text.trim();
  final start = groupCommandTokenStart(trimmed);
  if (start == null) return const [];
  return agentSkillInvocationTags(trimmed.substring(start), chosen);
}
