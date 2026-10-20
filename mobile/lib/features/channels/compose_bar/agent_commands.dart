part of '../compose_bar.dart';

/// The composer's "/" autocomplete in a 1:1 agent DM: conversation commands
/// and the agent's skills, fetched lazily from the hosted route the first
/// time "/" opens for that agent.
class _AgentCommandAutocomplete {
  const _AgentCommandAutocomplete({
    required this.suggestions,
    required this.select,
    required this.tagsFor,
    required this.clear,
  });

  /// Rows to show now; empty when no "/" query is open.
  final List<AgentCommand> suggestions;
  final ValueChanged<AgentCommand> select;

  /// The `buzz-skill` tag for [text] when it starts with a picked skill.
  final List<List<String>> Function(String text) tagsFor;

  /// Forget picked skills (the draft was sent or cleared).
  final VoidCallback clear;
}

_AgentCommandAutocomplete _useAgentCommandAutocomplete(
  WidgetRef ref, {
  required String? agentPubkey,
  required TextEditingController controller,
  required FocusNode focusNode,
}) {
  final query = useState<String?>(null);
  final chosen = useRef(<String, AgentCommand>{});
  useEffect(() {
    if (agentPubkey == null) {
      query.value = null;
      return null;
    }
    void listener() {
      final value = controller.value;
      final selection = value.selection;
      query.value = selection.isValid && selection.isCollapsed
          ? findAgentCommandQuery(value.text, selection.baseOffset)?.query
          : null;
    }

    listener();
    controller.addListener(listener);
    return () => controller.removeListener(listener);
  }, [controller, agentPubkey]);

  final open = agentPubkey != null && query.value != null;
  final commands = open
      ? ref.watch(agentCommandsProvider(agentPubkey)).value ?? const []
      : const <AgentCommand>[];
  final suggestions = open
      ? filterAgentCommands(commands, query.value!)
      : const <AgentCommand>[];

  void select(AgentCommand command) {
    if (command.kind == AgentCommandKind.skill) {
      chosen.value[command.name] = command;
    }
    final text = controller.text;
    final firstSpace = text.indexOf(RegExp(r'\s'));
    final end = firstSpace < 0 ? text.length : firstSpace;
    controller.value = TextEditingValue(
      text: '/${command.name} ${text.substring(end).trimLeft()}',
      selection: TextSelection.collapsed(offset: command.name.length + 2),
    );
    query.value = null;
    focusNode.requestFocus();
  }

  return _AgentCommandAutocomplete(
    suggestions: suggestions,
    select: select,
    tagsFor: (text) => agentSkillInvocationTags(text, chosen.value),
    clear: chosen.value.clear,
  );
}

class _AgentCommandSuggestions extends StatelessWidget {
  const _AgentCommandSuggestions({
    required this.suggestions,
    required this.onSelect,
  });

  final List<AgentCommand> suggestions;
  final ValueChanged<AgentCommand> onSelect;

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
        constraints: const BoxConstraints(maxHeight: 240),
        child: ListView.builder(
          shrinkWrap: true,
          padding: const EdgeInsets.symmetric(vertical: Grid.xxs),
          itemCount: suggestions.length,
          itemBuilder: (context, index) {
            final command = suggestions[index];
            final hint = command.argumentHint;
            final detail = command.description;
            return ListTile(
              key: ValueKey(
                'agent-command-${command.kind.name}-${command.name}',
              ),
              dense: true,
              visualDensity: VisualDensity.compact,
              title: Text.rich(
                TextSpan(
                  text: '/${command.name}',
                  children: [
                    if (hint != null)
                      TextSpan(
                        text: '  $hint',
                        style: TextStyle(
                          color: context.colors.onSurfaceVariant,
                        ),
                      ),
                  ],
                ),
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
          },
        ),
      ),
    );
  }
}
