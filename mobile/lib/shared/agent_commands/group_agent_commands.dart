import 'agent_commands.dart';

/// The "/" popup in a channel or thread. Unlike a 1:1 DM the conversation
/// has no single agent, so the popup needs a target agent: one mentioned
/// before the "/" (`@Scout /rev`, `ask @Scout to /rev`), else the channel's
/// only agent.

/// Agents offered to choose from when the target is ambiguous.
const maxGroupCommandAgentChoices = 20;

/// Where the `/` of a leading command starts in [text]: at the very start,
/// or right after a leading `@…` mention on the first line. Null otherwise.
/// Only a leading command can be a session command (`/new`).
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
    required this.tokenEnd,
    required this.prefix,
  });

  /// What follows the `/`, lowercased.
  final String query;

  /// Offset of the `/`.
  final int tokenStart;

  /// End offset of the token.
  final int tokenEnd;

  /// The text before the `/` (empty, `@Name `, or any words).
  final String prefix;
}

/// The "/" query at [cursor] in [text], or `null` when none is open. Like
/// `@` and `#`, the "/" opens at any word start.
GroupAgentCommandQuery? findGroupAgentCommandQuery(String text, int cursor) {
  final open = findAgentCommandQuery(text, cursor);
  if (open == null) return null;
  return GroupAgentCommandQuery(
    query: open.query,
    tokenStart: open.tokenStart,
    tokenEnd: open.tokenEnd,
    prefix: text.substring(0, open.tokenStart),
  );
}

final _mentionStart = RegExp(r'(^|[\s(\[{])@\S');

/// Whether [prefix] (the text before a "/") mentions someone: an `@` that
/// opens a word, not one inside an email address.
bool mentionsSomeone(String prefix) => _mentionStart.hasMatch(prefix);

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

/// What is known of an agent's group "/" list.
enum GroupCommandListState { unknown, empty, some }

/// Narrow a choice of several agents by what each offers: an agent whose
/// list came back empty (nothing the person may use with it) is no choice,
/// and when only one agent with commands is left the "/" is for it. Agents
/// still loading stay on offer. Null when none is left.
GroupCommandTarget? narrowGroupCommandTarget(
  GroupCommandTarget target,
  GroupCommandListState Function(String pubkey) listState,
) {
  if (target.choices.isEmpty) return target;
  final open = [
    for (final pubkey in target.choices)
      if (listState(pubkey) != GroupCommandListState.empty) pubkey,
  ];
  if (open.isEmpty) return null;
  if (open.length == 1 &&
      listState(open.single) == GroupCommandListState.some) {
    return (agent: open.single, choices: const []);
  }
  return (agent: null, choices: open);
}

/// The `buzz-skill` tag for a channel or thread message holding a skill
/// picked from the popup (`[@Name ]/skill args`, or anywhere in the message).
List<List<String>> groupAgentSkillInvocationTags(
  String text,
  Map<String, AgentCommand> chosen,
) {
  final trimmed = text.trim();
  return agentSkillInvocationTags(
    trimmed,
    chosen,
    leadingStart: groupCommandTokenStart(trimmed) ?? -1,
  );
}
