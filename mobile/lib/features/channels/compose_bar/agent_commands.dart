part of '../compose_bar.dart';

/// The composer's "/" autocomplete. In a 1:1 agent DM: conversation commands,
/// the agent's skills and the other registry skills the person may use,
/// fetched lazily from the hosted route the first time "/" opens for that
/// agent. In a channel or thread the "/" may follow a mention of the agent it
/// is for (`@Scout /review`); otherwise it is for the channel's only agent,
/// and with several the popup first offers them. The group list never has
/// personal skills, and session commands only for the agent's owner.
class _AgentCommandAutocomplete {
  const _AgentCommandAutocomplete({
    required this.suggestions,
    required this.title,
    required this.select,
    required this.tagsFor,
    required this.mentionsFor,
    required this.clear,
  });

  /// Rows to show now; empty when no "/" query is open.
  final List<AgentCommand> suggestions;

  /// The popup's heading in a channel (`Skills for @Scout`), else null.
  final String? title;
  final ValueChanged<AgentCommand> select;

  /// The `buzz-skill` tag for [text] when it starts with a picked skill.
  final List<List<String>> Function(String text) tagsFor;

  /// Agents a channel session command picked from the popup is addressed to
  /// (its text is the bare command, which the server needs exactly).
  final List<String> Function(String text) mentionsFor;

  /// Forget picked skills (the draft was sent or cleared).
  final VoidCallback clear;
}

/// A channel's agent members and how to bind a mention of one.
class _GroupAgentCommandContext {
  const _GroupAgentCommandContext({
    required this.agents,
    required this.mentionMap,
    required this.bindMention,
  });

  /// The channel's agent members.
  final List<MentionCandidate> agents;

  /// Mentions picked in the draft, by label.
  final Map<String, MentionCandidate> mentionMap;

  /// Records a picked mention and returns the label to insert.
  final String Function(MentionCandidate candidate) bindMention;

  /// The agent mentioned first in [prefix] (`@Name `), or null.
  MentionCandidate? agentIn(String prefix) {
    MentionCandidate? found;
    var length = -1;
    for (final entry in mentionMap.entries) {
      if (entry.key.length > length && prefix.startsWith('@${entry.key}')) {
        found = entry.value;
        length = entry.key.length;
      }
    }
    return found != null && found.isAgent ? found : null;
  }

  MentionCandidate? agent(String pubkey) => agents
      .where((candidate) => candidate.pubkey.toLowerCase() == pubkey)
      .firstOrNull;
}

_AgentCommandAutocomplete _useAgentCommandAutocomplete(
  WidgetRef ref, {
  required String? agentPubkey,
  required _GroupAgentCommandContext? group,
  required TextEditingController controller,
  required FocusNode focusNode,
  required Future<bool> Function(String? agentName) confirmNewSession,
  required VoidCallback submit,
}) {
  final query = useState<String?>(null);
  final groupQuery = useState<GroupAgentCommandQuery?>(null);
  final chosen = useRef(<String, AgentCommand>{});
  final sessionTarget = useRef<({String text, String pubkey})?>(null);
  final groupMode = agentPubkey == null && group != null;
  useEffect(() {
    if (agentPubkey == null && !groupMode) {
      query.value = null;
      groupQuery.value = null;
      return null;
    }
    void listener() {
      final value = controller.value;
      final selection = value.selection;
      final collapsed = selection.isValid && selection.isCollapsed;
      if (groupMode) {
        groupQuery.value = collapsed
            ? findGroupAgentCommandQuery(value.text, selection.baseOffset)
            : null;
        query.value = groupQuery.value?.query;
      } else {
        query.value = collapsed
            ? findAgentCommandQuery(value.text, selection.baseOffset)?.query
            : null;
      }
    }

    listener();
    controller.addListener(listener);
    return () => controller.removeListener(listener);
  }, [controller, agentPubkey, groupMode]);

  final open = groupMode ? groupQuery.value : null;
  final resolved = open == null || group == null
      ? null
      : resolveGroupCommandTarget(
          hasPrefix: open.prefix.isNotEmpty,
          prefixAgent: group.agentIn(open.prefix)?.pubkey.toLowerCase(),
          channelAgents: [for (final agent in group.agents) agent.pubkey],
        );
  // With several agents, load each one's list so agents that offer nothing
  // drop out (and the one left, if only one, is the target).
  final target = resolved == null || resolved.choices.isEmpty
      ? resolved
      : narrowGroupCommandTarget(resolved, (pubkey) {
          final list = ref.watch(agentGroupCommandsProvider(pubkey));
          final value = list.value;
          return value == null
              ? GroupCommandListState.unknown
              : value.isEmpty
              ? GroupCommandListState.empty
              : GroupCommandListState.some;
        });
  final commandAgent = groupMode ? target?.agent : agentPubkey;
  final listOpen = commandAgent != null && query.value != null;
  final audience = groupMode
      ? AgentCommandAudience.group
      : AgentCommandAudience.private;
  final listed = !listOpen
      ? const <AgentCommand>[]
      : ref
                .watch(
                  groupMode
                      ? agentGroupCommandsProvider(commandAgent)
                      : agentCommandsProvider(commandAgent),
                )
                .value ??
            const <AgentCommand>[];
  // A list the server cut short: what is typed is searched on the server
  // too, so every skill the person may use can be found.
  final search = listOpen ? normalizeAgentCommandQuery(query.value!) : '';
  final searched =
      search.isNotEmpty && agentCommandsTruncated(ref, commandAgent!, audience)
      ? ref
                .watch(
                  agentCommandSearchProvider((
                    agent: commandAgent,
                    audience: audience,
                    query: search,
                  )),
                )
                .value ??
            const <AgentCommand>[]
      : const <AgentCommand>[];
  final commands = searched.isEmpty
      ? listed
      : mergeAgentCommands(searched, listed);
  final List<AgentCommand> suggestions;
  if (listOpen) {
    suggestions = filterAgentCommands(commands, query.value!);
  } else if (target != null && target.choices.isNotEmpty && group != null) {
    final q = query.value ?? '';
    final choices = [
      for (final pubkey in target.choices)
        if (group.agent(pubkey) case final agent?)
          AgentCommand.agent(name: agent.label, agentPubkey: pubkey),
    ];
    // Typing a command name before choosing keeps the agents on offer; the
    // choice then opens that agent's matches for what was typed.
    final matching = [
      for (final choice in choices)
        if (choice.name.toLowerCase().contains(q)) choice,
    ];
    suggestions = matching.isEmpty ? choices : matching;
  } else {
    suggestions = const [];
  }
  final targetLabel = groupMode && commandAgent != null
      ? (group.agentIn(open?.prefix ?? '') ?? group.agent(commandAgent))?.label
      : null;

  void setText(String text, int caret) {
    controller.value = TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: caret),
    );
    query.value = null;
    groupQuery.value = null;
    focusNode.requestFocus();
  }

  /// `/new` resets the agent's session (in a channel, a shared thread's), so
  /// picking it asks first and then sends it at once.
  Future<void> startNewSession(String? pubkey, String? agentName) async {
    query.value = null;
    groupQuery.value = null;
    if (!await confirmNewSession(agentName)) return;
    if (groupMode && pubkey != null) {
      sessionTarget.value = (text: '/new', pubkey: pubkey);
    }
    controller.value = const TextEditingValue(
      text: '/new',
      selection: TextSelection.collapsed(offset: 4),
    );
    submit();
  }

  void select(AgentCommand command) {
    final text = controller.text;
    if (command.kind == AgentCommandKind.session && command.name == 'new') {
      unawaited(startNewSession(commandAgent, targetLabel));
      return;
    }
    if (!groupMode || open == null) {
      if (command.kind == AgentCommandKind.skill) {
        chosen.value[command.name] = command;
      }
      final firstSpace = text.indexOf(RegExp(r'\s'));
      final end = firstSpace < 0 ? text.length : firstSpace;
      setText(
        '/${command.name} ${text.substring(end).trimLeft()}',
        command.name.length + 2,
      );
      return;
    }
    final afterToken = text.indexOf(RegExp(r'\s'), open.tokenStart);
    final rest = afterToken < 0 ? '' : text.substring(afterToken).trimLeft();
    switch (command.kind) {
      case AgentCommandKind.agent:
        final agent = group.agent(command.agentPubkey!);
        if (agent == null) return;
        final label = group.bindMention(agent);
        // Keep what was typed after "/": the agent's list opens on it.
        final prefix = '@$label /${query.value ?? ''}';
        setText(rest.isEmpty ? prefix : '$prefix $rest', prefix.length);
      case AgentCommandKind.session:
        // The server reads the bare command, so the mention is dropped and
        // the agent is addressed with a tag instead.
        if (commandAgent == null) return;
        final typed = '/${command.name}';
        sessionTarget.value = (text: typed, pubkey: commandAgent);
        setText('$typed ', typed.length + 1);
      case AgentCommandKind.skill:
        if (commandAgent == null) return;
        chosen.value[command.name] = command;
        var prefix = open.prefix;
        if (prefix.isEmpty) {
          final agent = group.agent(commandAgent);
          if (agent == null) return;
          prefix = '@${group.bindMention(agent)} ';
        }
        final head = '$prefix/${command.name} ';
        setText('$head$rest', head.length);
    }
  }

  return _AgentCommandAutocomplete(
    suggestions: suggestions,
    title: targetLabel == null ? null : 'Skills for @$targetLabel',
    select: select,
    tagsFor: (text) => groupMode
        ? groupAgentSkillInvocationTags(text, chosen.value)
        : agentSkillInvocationTags(text, chosen.value),
    mentionsFor: (text) {
      final target = sessionTarget.value;
      return target != null && text.trim() == target.text
          ? [target.pubkey]
          : const [];
    },
    clear: () {
      chosen.value.clear();
      sessionTarget.value = null;
    },
  );
}

/// Asks before a picked `/new` ends the agent's current session.
Future<bool> _confirmNewAgentSession(
  BuildContext context,
  String? agentName,
) async =>
    await showBuzzDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog.adaptive(
        title: const Text('Start a new session?'),
        content: Text(
          '${agentName ?? 'The agent'} ends its current session. Your next '
          'message starts a fresh one.',
        ),
        actions: [
          TextButton(
            key: const ValueKey('agent-command-new-cancel'),
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            key: const ValueKey('agent-command-new-confirm'),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('New session'),
          ),
        ],
      ),
    ) ==
    true;

class _AgentCommandSuggestions extends StatelessWidget {
  const _AgentCommandSuggestions({
    required this.suggestions,
    required this.onSelect,
    this.title,
  });

  final List<AgentCommand> suggestions;
  final ValueChanged<AgentCommand> onSelect;

  /// Names the agent the rows are for, in a channel.
  final String? title;

  @override
  Widget build(BuildContext context) {
    return Material(
      key: const ValueKey('agent-command-suggestions-popover'),
      type: MaterialType.card,
      color: appPopoverColor(context),
      surfaceTintColor: Colors.transparent,
      elevation: appPopoverElevation,
      shadowColor: appPopoverShadowColor(context),
      shape: appPopoverShape(context),
      clipBehavior: Clip.hardEdge,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxHeight: 320),
        child: ListView.builder(
          shrinkWrap: true,
          padding: const EdgeInsets.symmetric(vertical: Grid.xxs),
          itemCount: suggestions.length + (title == null ? 0 : 1),
          itemBuilder: (context, row) {
            final title = this.title;
            if (title != null && row == 0) {
              return Padding(
                key: const ValueKey('agent-command-title'),
                padding: const EdgeInsets.fromLTRB(
                  Grid.xs,
                  Grid.xxs,
                  Grid.xs,
                  0,
                ),
                child: Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: context.textTheme.labelMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                ),
              );
            }
            final index = title == null ? row : row - 1;
            final command = suggestions[index];
            final hint = command.argumentHint;
            final detail = command.description;
            final displayName = command.displayName;
            final startsSection =
                index == 0 || suggestions[index - 1].section != command.section;
            final tile = ListTile(
              key: ValueKey(
                'agent-command-${command.kind.name}-${command.name}',
              ),
              dense: true,
              visualDensity: VisualDensity.compact,
              title: Text.rich(
                TextSpan(
                  text: command.kind == AgentCommandKind.agent
                      ? '@${command.name}'
                      : '/${command.name}',
                  children: [
                    if (displayName != null)
                      TextSpan(
                        text: '  $displayName',
                        style: TextStyle(
                          color: context.colors.onSurfaceVariant,
                        ),
                      ),
                    if (hint != null)
                      TextSpan(
                        text: '  $hint',
                        style: TextStyle(
                          color: context.colors.onSurfaceVariant,
                        ),
                      ),
                  ],
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: context.textTheme.titleSmall,
              ),
              subtitle: detail == null || detail.isEmpty
                  ? null
                  : Text(
                      detail,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: context.textTheme.labelSmall?.copyWith(
                        color: context.colors.onSurfaceVariant,
                      ),
                    ),
              onTap: () => _runComposerAction(() => onSelect(command)),
            );
            if (!startsSection) return tile;
            return Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: [
                Padding(
                  key: ValueKey(
                    'agent-command-section-${command.section.name}',
                  ),
                  padding: const EdgeInsets.fromLTRB(
                    Grid.xs,
                    Grid.xxs,
                    Grid.xs,
                    Grid.half,
                  ),
                  child: Text(
                    command.section.label,
                    style: context.textTheme.labelSmall?.copyWith(
                      color: context.colors.onSurfaceVariant,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                tile,
              ],
            );
          },
        ),
      ),
    );
  }
}
