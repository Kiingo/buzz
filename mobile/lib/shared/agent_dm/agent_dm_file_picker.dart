import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../theme/theme.dart';
import '../widgets/buzz_loading_indicator.dart';
import '../widgets/modal_presentation.dart';
import 'agent_dm_session_files.dart';

/// Opens the list a "/file" pick asks for (BZ-FILES); the path picked, or
/// null when the sheet closes without one.
Future<String?> showAgentDmFilePicker(
  BuildContext context, {
  required String agentPubkey,
}) {
  final mediaQuery = MediaQuery.of(context);
  return showBuzzModalBottomSheet<String>(
    context: context,
    title: 'Reference a file',
    isScrollControlled: true,
    showDragHandle: true,
    constraints: BoxConstraints(
      maxWidth: 640,
      maxHeight: mediaQuery.size.height - mediaQuery.viewPadding.top - Grid.xs,
    ),
    builder: (_) => AgentDmFilePicker(agentPubkey: agentPubkey),
  );
}

String _baseName(String path) =>
    path.split('/').where((part) => part.isNotEmpty).lastOrNull ?? path;

String? _parentOf(String path) {
  final parts = path.split('/').where((part) => part.isNotEmpty).toList();
  return parts.length > 1 ? parts.sublist(0, parts.length - 1).join('/') : null;
}

/// The names in the reader's own session's project folder, the same list
/// the apps' "@" picker shows. A folder opens; a file returns its path to
/// the composer. Typing searches the whole folder.
class AgentDmFilePicker extends HookConsumerWidget {
  const AgentDmFilePicker({super.key, required this.agentPubkey});

  final String agentPubkey;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final search = useTextEditingController();
    final typed = useState('');
    final query = useState('');
    final dir = useState<String?>(null);
    // Later pages, after the first: each a cursor the host gave.
    final cursors = useState<List<String>>(const []);
    useEffect(() {
      final timer = Timer(const Duration(milliseconds: 200), () {
        query.value = typed.value.trim();
      });
      return timer.cancel;
    }, [typed.value]);
    useEffect(() {
      cursors.value = const [];
      return null;
    }, [query.value, dir.value]);
    final searching = query.value.isNotEmpty;
    ({String agentPubkey, String? dir, String query, String? cursor}) keyFor(
      String? cursor,
    ) => (
      agentPubkey: agentPubkey.toLowerCase(),
      dir: searching ? null : dir.value,
      query: query.value,
      cursor: cursor,
    );
    final first = ref.watch(agentDmSessionFilesProvider(keyFor(null)));
    final later = [
      for (final cursor in cursors.value)
        ref.watch(agentDmSessionFilesProvider(keyFor(cursor))),
    ];
    final pages = [first, ...later];
    final rows = [for (final page in pages) ...?page.value?.entries];
    final failed = pages.where((page) => page.hasError).firstOrNull;
    final note = first.value?.note;
    final loading = pages.any((page) => page.isLoading);
    final next = pages.last.value?.nextCursor;
    final muted = context.textTheme.bodySmall?.copyWith(
      color: context.colors.onSurfaceVariant,
    );
    final currentDir = dir.value;

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
            "From your own session's project folder. The agent gets the "
            "file's name with your message.",
            style: muted,
          ),
          const SizedBox(height: Grid.xxs),
          TextField(
            key: const ValueKey('agent-file-picker-search'),
            controller: search,
            autofocus: true,
            decoration: const InputDecoration(hintText: 'Search files'),
            onChanged: (value) => typed.value = value,
          ),
          if (!searching && currentDir != null)
            Row(
              children: [
                TextButton(
                  onPressed: () => dir.value = _parentOf(currentDir),
                  child: const Text('Up'),
                ),
                Expanded(
                  child: Text(
                    currentDir,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: muted,
                  ),
                ),
              ],
            ),
          const SizedBox(height: Grid.xxs),
          if (failed != null)
            Row(
              children: [
                Expanded(
                  child: Text(agentDmSessionFilesErrorSentence(failed.error!)),
                ),
                TextButton(
                  key: const ValueKey('agent-file-picker-retry'),
                  onPressed: () {
                    for (final cursor in [null, ...cursors.value]) {
                      ref.invalidate(
                        agentDmSessionFilesProvider(keyFor(cursor)),
                      );
                    }
                  },
                  child: const Text('Try again'),
                ),
              ],
            ),
          if (note != null)
            Padding(
              padding: const EdgeInsets.all(Grid.xs),
              child: Text(note, style: muted),
            ),
          if (rows.isEmpty && loading)
            const Padding(
              padding: EdgeInsets.all(Grid.xs),
              child: Center(
                child: BuzzLoadingIndicator(size: 24, semanticLabel: 'Loading'),
              ),
            ),
          if (rows.isEmpty && !loading && failed == null && note == null)
            Padding(
              padding: const EdgeInsets.all(Grid.xs),
              child: Text(
                searching ? 'No files match.' : 'This folder is empty.',
              ),
            ),
          if (rows.isNotEmpty)
            Flexible(
              child: ListView.builder(
                shrinkWrap: true,
                itemCount: rows.length + (next != null ? 1 : 0),
                itemBuilder: (context, index) {
                  if (index == rows.length) {
                    return TextButton(
                      key: const ValueKey('agent-file-picker-more'),
                      onPressed: loading
                          ? null
                          : () => cursors.value = [...cursors.value, next!],
                      child: Text(loading ? 'Loading…' : 'More'),
                    );
                  }
                  final row = rows[index];
                  final parent = _parentOf(row.path);
                  return ListTile(
                    key: ValueKey('agent-file-${row.path}'),
                    dense: true,
                    leading: Icon(
                      row.isDirectory
                          ? Icons.folder_outlined
                          : Icons.insert_drive_file_outlined,
                      size: 20,
                    ),
                    title: Text(
                      _baseName(row.path),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    subtitle: searching && parent != null
                        ? Text(
                            parent,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          )
                        : null,
                    onTap: () {
                      if (row.isDirectory) {
                        search.clear();
                        typed.value = '';
                        query.value = '';
                        dir.value = row.path;
                        return;
                      }
                      Navigator.of(context).pop(row.path);
                    },
                  );
                },
              ),
            ),
        ],
      ),
    );
  }
}
