import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../theme/theme.dart';
import '../widgets/buzz_loading_indicator.dart';
import '../widgets/modal_presentation.dart';
import 'agent_dm_refs.dart';

/// Opens the search a "/task" or "/project" pick asks for (BUZZPARITY B5);
/// the reference picked, or null when the sheet closes without one.
Future<AgentDmRef?> showAgentDmRefPicker(
  BuildContext context, {
  required String agentPubkey,
  required String type,
}) {
  final mediaQuery = MediaQuery.of(context);
  return showBuzzModalBottomSheet<AgentDmRef>(
    context: context,
    title: type == 'project' ? 'Reference a project' : 'Reference a task',
    isScrollControlled: true,
    showDragHandle: true,
    constraints: BoxConstraints(
      maxWidth: 640,
      maxHeight: mediaQuery.size.height - mediaQuery.viewPadding.top - Grid.xs,
    ),
    builder: (_) => AgentDmRefPicker(agentPubkey: agentPubkey, type: type),
  );
}

/// What the reader can read, from the host, as they type. A tap returns the
/// reference to the composer, which puts its label in the draft.
class AgentDmRefPicker extends HookConsumerWidget {
  const AgentDmRefPicker({
    super.key,
    required this.agentPubkey,
    required this.type,
  });

  final String agentPubkey;

  /// `task` or `project`.
  final String type;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final typed = useState('');
    final query = useState('');
    // A pause in typing before the search goes out.
    useEffect(() {
      final timer = Timer(const Duration(milliseconds: 200), () {
        query.value = typed.value.trim();
      });
      return timer.cancel;
    }, [typed.value]);
    final key = (
      agentPubkey: agentPubkey.toLowerCase(),
      type: type,
      query: query.value,
    );
    final search = ref.watch(agentDmRefSearchProvider(key));
    final noun = type == 'project' ? 'project' : 'task';
    return Padding(
      padding: EdgeInsets.only(
        left: Grid.xs,
        right: Grid.xs,
        bottom: MediaQuery.viewInsetsOf(context).bottom + Grid.xs,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            'Only what you can read. The agent gets its title with your '
            'message.',
            style: context.textTheme.bodySmall?.copyWith(
              color: context.colors.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: Grid.xxs),
          TextField(
            key: const ValueKey('agent-ref-picker-search'),
            autofocus: true,
            decoration: InputDecoration(hintText: 'Search ${noun}s'),
            onChanged: (value) => typed.value = value,
          ),
          const SizedBox(height: Grid.xxs),
          Flexible(
            child: search.when(
              loading: () => const Padding(
                padding: EdgeInsets.all(Grid.xs),
                child: Center(
                  child: BuzzLoadingIndicator(
                    size: 24,
                    semanticLabel: 'Searching',
                  ),
                ),
              ),
              error: (error, _) => Row(
                children: [
                  Expanded(child: Text(agentDmRefsErrorSentence(error))),
                  TextButton(
                    key: const ValueKey('agent-ref-picker-retry'),
                    onPressed: () =>
                        ref.invalidate(agentDmRefSearchProvider(key)),
                    child: const Text('Try again'),
                  ),
                ],
              ),
              data: (rows) => rows.isEmpty
                  ? Padding(
                      padding: const EdgeInsets.all(Grid.xs),
                      child: Text('No ${noun}s match.'),
                    )
                  : ListView.builder(
                      shrinkWrap: true,
                      itemCount: rows.length,
                      itemBuilder: (context, index) {
                        final row = rows[index];
                        final subtitle = row.subtitle;
                        return ListTile(
                          key: ValueKey('agent-ref-${row.type}-${row.id}'),
                          dense: true,
                          title: Text(
                            row.title.isEmpty ? 'Untitled' : row.title,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                          subtitle: subtitle == null
                              ? null
                              : Text(
                                  subtitle,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                ),
                          onTap: () => Navigator.of(context).pop(row),
                        );
                      },
                    ),
            ),
          ),
        ],
      ),
    );
  }
}
