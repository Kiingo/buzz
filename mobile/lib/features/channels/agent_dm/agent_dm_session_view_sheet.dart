import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';
import 'package:uuid/uuid.dart';

import '../../../shared/agent_dm/agent_dm_session_export.dart';
import '../../../shared/agent_dm/agent_dm_session_views.dart';
import '../../../shared/theme/theme.dart';
import '../../../shared/widgets/modal_presentation.dart';

/// Opens one read-only view of the reader's own session: a screen (a subagent's
/// row opens it, the /rewind screen goes back), the files it changed, their own
/// queued messages (each with Edit and Withdraw), or the conversation as a file
/// to share (`/export`).
Future<void> showAgentDmSessionViewSheet(
  BuildContext context,
  String agentPubkey,
  AgentDmSessionView view,
) => showBuzzModalBottomSheet<void>(
  context: context,
  title: switch (view.kind) {
    'files' => 'Files changed',
    'queued' => 'Queued messages',
    'export' => 'Export conversation',
    _ => 'Session',
  },
  isScrollControlled: true,
  builder: (_) => _AgentDmSessionViewSheet(
    agentPubkey: agentPubkey.toLowerCase(),
    view: view,
  ),
);

class _AgentDmSessionViewSheet extends HookConsumerWidget {
  const _AgentDmSessionViewSheet({
    required this.agentPubkey,
    required this.view,
  });

  final String agentPubkey;
  final AgentDmSessionView view;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final provider = agentDmSessionViewProvider((
      agentPubkey: agentPubkey,
      view: view,
    ));
    final read = ref.watch(provider);
    final value = read.value;
    final withdrawing = useState<String?>(null);
    final editing = useState<String?>(null);
    final rewindKey = useRef(const Uuid().v4());
    final muted = context.textTheme.bodySmall?.copyWith(
      color: context.colors.onSurfaceVariant,
    );
    final messenger = ScaffoldMessenger.maybeOf(context);

    Future<void> withdraw(String messageId) async {
      withdrawing.value = messageId;
      String text;
      try {
        await ref
            .read(agentDmSessionViewActionsProvider)
            .withdraw(agentPubkey, messageId);
        text = "Withdrawn. It won't reach the session.";
      } catch (error) {
        text = agentDmSessionViewErrorSentence(error);
      } finally {
        if (context.mounted) withdrawing.value = null;
      }
      messenger?.showSnackBar(SnackBar(content: Text(text)));
    }

    /// Edit sends once, from the person's own text; taken meanwhile says so
    /// and the list reads again. It never resends.
    Future<void> edit(AgentDmQueuedMessage message) async {
      final text = await showBuzzDialog<String>(
        context: context,
        builder: (_) => _EditQueuedDialog(body: message.body),
      );
      if (text == null || !context.mounted) return;
      editing.value = message.messageId;
      String notice;
      try {
        await ref
            .read(agentDmSessionViewActionsProvider)
            .edit(agentPubkey, message.messageId, text);
        notice = 'Edited. The session gets the new text.';
      } catch (error) {
        notice = agentDmSessionViewErrorSentence(error);
      } finally {
        if (context.mounted) editing.value = null;
      }
      messenger?.showSnackBar(SnackBar(content: Text(notice)));
    }

    /// Stop asks first, and reports a request, never a stopped task.
    Future<void> stopTask(String taskId) async {
      final stop = await showBuzzDialog<bool>(
        context: context,
        builder: (dialogContext) => AlertDialog.adaptive(
          title: const Text('Stop this task?'),
          content: const Text(
            'The session is asked to stop this background task.',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              key: const ValueKey('agent-dm-stop-task-confirm'),
              onPressed: () => Navigator.of(dialogContext).pop(true),
              child: const Text('Stop'),
            ),
          ],
        ),
      );
      if (stop != true || !context.mounted) return;
      String text;
      try {
        text = await ref
            .read(agentDmSessionViewActionsProvider)
            .stopTask(agentPubkey, taskId);
      } catch (error) {
        text = agentDmStopTaskErrorSentence(error);
      }
      messenger?.showSnackBar(SnackBar(content: Text(text)));
    }

    /// /rewind, as in the apps: pick what goes back, then confirm. One key until
    /// the host accepts it, so a retry is a replay. A 409 reads the list again.
    Future<void> rewindTo(AgentDmRewindControl control, String? edits) async {
      final scope = await showBuzzDialog<String>(
        context: context,
        builder: (_) => _RewindDialog(control: control, edits: edits),
      );
      if (scope == null || !context.mounted) return;
      final actions = ref.read(agentDmSessionViewActionsProvider);
      String text;
      try {
        text = await actions.rewind(
          agentPubkey,
          control,
          scope,
          rewindKey.value,
        );
        rewindKey.value = const Uuid().v4();
        ref.invalidate(provider);
      } catch (error) {
        final refusal = agentDmRewindRefusal(error);
        text = refusal.sentence;
        if (refusal.readAgain) {
          rewindKey.value = const Uuid().v4();
          ref.invalidate(provider);
        }
      }
      messenger?.showSnackBar(SnackBar(content: Text(text)));
    }

    // A failed read keeps what showed and says so; never shown as empty.
    final failure = read.hasError
        ? Padding(
            padding: const EdgeInsets.symmetric(horizontal: Grid.xs),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    agentDmSessionViewErrorSentence(read.error!),
                    style: context.textTheme.bodySmall,
                  ),
                ),
                TextButton(
                  onPressed: () => ref.invalidate(provider),
                  child: const Text('Try again'),
                ),
              ],
            ),
          )
        : null;

    final List<Widget> body;
    if (value == null) {
      body = [
        if (!read.hasError)
          Padding(
            padding: const EdgeInsets.all(Grid.xs),
            child: Text('Loading…', style: muted),
          ),
      ];
    } else if (value.sections case final sections?) {
      body = [
        if (value.description case final description?
            when description.isNotEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: Grid.xs),
            child: Text(description, style: muted),
          ),
        for (final section in sections) ...[
          if (section.title.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(
                Grid.xs,
                Grid.twelve,
                Grid.xs,
                Grid.half,
              ),
              child: Semantics(
                header: true,
                child: Text(
                  section.title,
                  style: context.textTheme.labelMedium?.copyWith(
                    color: context.colors.onSurfaceVariant,
                  ),
                ),
              ),
            ),
          if (section.note case final note?)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: Grid.xs),
              child: Text(note, style: muted),
            ),
          if (section.unavailable)
            Padding(
              padding: const EdgeInsets.all(Grid.xs),
              child: Text(
                "Couldn't read this part of the session.",
                style: muted,
              ),
            )
          else if (section.rows.isEmpty)
            Padding(
              padding: const EdgeInsets.all(Grid.xs),
              child: Text(section.empty ?? 'Nothing here.', style: muted),
            )
          else
            for (final row in section.rows)
              _ScreenRow(
                row: row,
                onStop: stopTask,
                onOpen: (sessionId) => unawaited(
                  showBuzzModalBottomSheet<void>(
                    context: context,
                    title: row.label,
                    isScrollControlled: true,
                    builder: (_) => _SubagentSheet(
                      agentPubkey: agentPubkey,
                      sessionId: sessionId,
                    ),
                  ),
                ),
                onRewind: (control) => unawaited(rewindTo(control, row.value)),
              ),
        ],
      ];
    } else if (value.exportFile case final file?) {
      body = [_ExportBody(file: file)];
    } else if (value.changes case final changes?) {
      body = [
        if (changes.isEmpty)
          Padding(
            padding: const EdgeInsets.all(Grid.xs),
            child: Text(
              "No file changes in this session's recent work.",
              style: muted,
            ),
          )
        else
          for (final change in changes)
            _FileChangeTile(key: ValueKey(change.id), change: change),
      ];
    } else {
      final queued = value.queued ?? const <AgentDmQueuedMessage>[];
      body = [
        if (queued.isEmpty)
          Padding(
            padding: const EdgeInsets.all(Grid.xs),
            child: Text(
              'Nothing of yours is waiting for this session.',
              style: muted,
            ),
          )
        else
          for (final message in queued)
            ListTile(
              key: ValueKey(message.messageId),
              title: Text(message.body),
              subtitle: message.idle
                  ? const Text('Waits for the session to be idle.')
                  : null,
              trailing: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  TextButton(
                    onPressed:
                        withdrawing.value == null && editing.value == null
                        ? () => unawaited(edit(message))
                        : null,
                    child: const Text('Edit'),
                  ),
                  TextButton(
                    onPressed:
                        withdrawing.value == null && editing.value == null
                        ? () => unawaited(withdraw(message.messageId))
                        : null,
                    child: const Text('Withdraw'),
                  ),
                ],
              ),
            ),
      ];
    }

    return SafeArea(
      child: ListView(
        key: const ValueKey('agent-dm-session-view'),
        shrinkWrap: true,
        children: [
          if (value?.title case final title? when title.isNotEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: Grid.xs),
              child: Text(title, style: context.textTheme.titleSmall),
            ),
          ?failure,
          ...body,
          const SizedBox(height: Grid.xs),
        ],
      ),
    );
  }
}

/// The file, ready to share. Nothing is sent unless the person sends it.
class _ExportBody extends StatelessWidget {
  const _ExportBody({required this.file});

  final AgentDmSessionExport file;

  Future<void> _share(BuildContext context) async {
    final messenger = ScaffoldMessenger.maybeOf(context);
    final box = context.findRenderObject() as RenderBox?;
    final origin = box == null
        ? null
        : box.localToGlobal(Offset.zero) & box.size;
    try {
      final directory = await getTemporaryDirectory();
      final path = '${directory.path}${Platform.pathSeparator}${file.fileName}';
      await File(path).writeAsString(file.markdown, flush: true);
      await SharePlus.instance.share(
        ShareParams(files: [XFile(path)], sharePositionOrigin: origin),
      );
    } catch (_) {
      messenger?.showSnackBar(
        const SnackBar(content: Text("Couldn't share the file. Try again.")),
      );
    }
  }

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: Grid.xs),
    child: Row(
      children: [
        Expanded(
          child: Text(
            '${file.turns == 1 ? '1 turn' : '${file.turns} turns'} ready to share.',
          ),
        ),
        Builder(
          builder: (buttonContext) => FilledButton(
            key: const ValueKey('agent-dm-export-share'),
            onPressed: () => unawaited(_share(buttonContext)),
            child: const Text('Share'),
          ),
        ),
      ],
    ),
  );
}

/// One subagent's conversation, oldest first: plain text, read only, over this
/// signed request and never the relay. A failed read says so.
class _SubagentSheet extends HookConsumerWidget {
  const _SubagentSheet({required this.agentPubkey, required this.sessionId});

  final String agentPubkey;
  final String sessionId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final turns = useState<List<AgentDmSubagentTurn>?>(null);
    final older = useState<String?>(null);
    final failure = useState<String?>(null);
    final loading = useState(false);
    final muted = context.textTheme.bodySmall?.copyWith(
      color: context.colors.onSurfaceVariant,
    );

    Future<void> load(String? before) async {
      loading.value = true;
      failure.value = null;
      try {
        final page = await ref
            .read(agentDmSessionViewActionsProvider)
            .subagentPage(agentPubkey, sessionId, before);
        if (!context.mounted) return;
        final shown = {for (final turn in turns.value ?? const []) turn.id};
        turns.value = [
          ...page.turns.where((turn) => !shown.contains(turn.id)),
          ...?turns.value,
        ];
        older.value = page.olderCursor;
      } catch (error) {
        if (context.mounted) {
          failure.value = agentDmSessionViewErrorSentence(error);
        }
      } finally {
        if (context.mounted) loading.value = false;
      }
    }

    useEffect(() {
      unawaited(load(null));
      return null;
    }, const []);

    final list = turns.value;
    return SafeArea(
      child: ListView(
        key: const ValueKey('agent-dm-subagent-view'),
        shrinkWrap: true,
        padding: const EdgeInsets.symmetric(horizontal: Grid.xs),
        children: [
          Text(
            "Read only: this subagent's messages and tool names, from your own session.",
            style: muted,
          ),
          if (failure.value case final text?)
            Row(
              children: [
                Expanded(child: Text(text, style: context.textTheme.bodySmall)),
                TextButton(
                  onPressed: () => unawaited(load(older.value)),
                  child: const Text('Try again'),
                ),
              ],
            ),
          if (list == null && loading.value) Text('Loading…', style: muted),
          if (older.value case final cursor?)
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton(
                onPressed: loading.value
                    ? null
                    : () => unawaited(load(cursor)),
                child: const Text('Older messages'),
              ),
            ),
          if (list != null && list.isEmpty)
            Text('Kiingo keeps no messages for this subagent yet.', style: muted),
          for (final turn in list ?? const <AgentDmSubagentTurn>[])
            Padding(
              key: ValueKey(turn.id),
              padding: const EdgeInsets.only(top: Grid.xs),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (turn.prompt case final prompt?)
                    SelectableText(
                      prompt,
                      style: context.textTheme.bodyMedium?.copyWith(
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  if (turn.omitted > 0)
                    Text('${turn.omitted} earlier steps not shown', style: muted),
                  for (final step in turn.steps) Text(step, style: muted),
                  if (turn.reply case final reply?) SelectableText(reply),
                ],
              ),
            ),
          const SizedBox(height: Grid.xs),
        ],
      ),
    );
  }
}

const _rewindScopeLabels = {
  'conversation': 'The conversation',
  'files': 'The code',
  'both': 'The conversation and the code',
};

/// What goes back, then Go back; returns the scope, or null on Cancel. The words
/// are the apps': the code is restored when the next message starts. Buzz also
/// says there's no undo for the code.
class _RewindDialog extends HookWidget {
  const _RewindDialog({required this.control, required this.edits});

  final AgentDmRewindControl control;
  final String? edits;

  @override
  Widget build(BuildContext context) {
    final scope = useState(control.scopes.first);
    final restoresCode = scope.value == 'files' || scope.value == 'both';
    final since = edits == null ? '' : ' (${edits!.toLowerCase()})';
    return AlertDialog.adaptive(
      title: const Text('What goes back'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          RadioGroup<String>(
            groupValue: scope.value,
            onChanged: (value) {
              if (value != null) scope.value = value;
            },
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                for (final option in control.scopes)
                  RadioListTile<String>(
                    key: ValueKey('agent-dm-rewind-scope-$option'),
                    value: option,
                    contentPadding: EdgeInsets.zero,
                    title: Text(_rewindScopeLabels[option] ?? option),
                  ),
              ],
            ),
          ),
          Text(
            '${restoresCode ? "The code is restored when your next message starts$since. There's no undo for the code." : 'Your next message continues from here. The code stays as it is.'}'
            '${scope.value == 'files' ? '' : ' The later messages stay saved, and this session can be loaded again.'}',
            style: context.textTheme.bodySmall,
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          key: const ValueKey('agent-dm-rewind-confirm'),
          onPressed: () => Navigator.of(context).pop(scope.value),
          child: const Text('Go back'),
        ),
      ],
    );
  }
}

class _ScreenRow extends StatelessWidget {
  const _ScreenRow({
    required this.row,
    required this.onStop,
    required this.onOpen,
    required this.onRewind,
  });

  final AgentDmScreenRow row;
  final ValueChanged<String> onStop;
  final ValueChanged<String> onOpen;
  final ValueChanged<AgentDmRewindControl> onRewind;

  @override
  Widget build(BuildContext context) {
    final muted = context.textTheme.bodySmall?.copyWith(
      color: context.colors.onSurfaceVariant,
    );
    final mono = context.textTheme.bodySmall?.copyWith(fontFamily: 'monospace');
    return Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: Grid.xs,
        vertical: Grid.quarter,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Text(
                  row.label,
                  style: row.mono ? mono : context.textTheme.bodyMedium,
                ),
              ),
              if (row.value case final value?) Text(value, style: muted),
            ],
          ),
          if (row.detail case final detail?) Text(detail, style: muted),
          if (row.body case final body?)
            Container(
              width: double.infinity,
              margin: const EdgeInsets.only(top: Grid.quarter),
              padding: const EdgeInsets.all(Grid.half),
              decoration: BoxDecoration(
                color: context.controlSurface,
                borderRadius: BorderRadius.circular(Radii.sm),
              ),
              child: SelectableText(body, style: mono),
            ),
          if (row.openSessionId case final sessionId?)
            TextButton(
              key: ValueKey('agent-dm-open-subagent-$sessionId'),
              onPressed: () => onOpen(sessionId),
              child: const Text('Open'),
            ),
          if (row.rewind case final control?)
            if (control.unavailable case final reason?)
              Text(reason, style: muted)
            else if (control.scopes.isEmpty)
              Text('Nothing here can go back.', style: muted)
            else
              TextButton(
                key: ValueKey('agent-dm-rewind-${control.turnIndex}'),
                onPressed: () => onRewind(control),
                child: const Text('Go back to here'),
              ),
          if (row.stopTaskId case final taskId?)
            if (row.stopUnavailable case final reason?)
              Text(reason, style: muted)
            else
              TextButton(
                key: ValueKey('agent-dm-stop-task-$taskId'),
                onPressed: () => onStop(taskId),
                child: const Text('Stop'),
              ),
        ],
      ),
    );
  }
}

class _FileChangeTile extends HookWidget {
  const _FileChangeTile({super.key, required this.change});

  final AgentDmFileChange change;

  @override
  Widget build(BuildContext context) {
    final open = useState(false);
    final mono = context.textTheme.bodySmall?.copyWith(fontFamily: 'monospace');
    final path = change.movedTo == null
        ? change.path
        : '${change.path} → ${change.movedTo}';
    final counts =
        '+${change.added} −${change.removed}'
        '${change.failed ? ' · may not have applied' : ''}';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        ListTile(
          dense: true,
          title: Text(path, style: mono),
          subtitle: Text(counts),
          trailing: Icon(
            open.value ? Icons.keyboard_arrow_up : Icons.keyboard_arrow_down,
          ),
          onTap: () => open.value = !open.value,
        ),
        if (open.value)
          Container(
            width: double.infinity,
            margin: const EdgeInsets.symmetric(horizontal: Grid.xs),
            padding: const EdgeInsets.all(Grid.half),
            decoration: BoxDecoration(
              color: context.controlSurface,
              borderRadius: BorderRadius.circular(Radii.sm),
            ),
            child: SelectableText.rich(
              TextSpan(
                children: [
                  for (final line in change.lines)
                    TextSpan(
                      text: '${line.sign} ${line.text}\n',
                      style: mono?.copyWith(
                        color: switch (line.sign) {
                          '+' => context.appColors.success,
                          '-' => context.colors.error,
                          _ => null,
                        },
                      ),
                    ),
                ],
              ),
            ),
          ),
      ],
    );
  }
}

/// The queued message's text to edit; Save returns it, Cancel returns null.
class _EditQueuedDialog extends HookWidget {
  const _EditQueuedDialog({required this.body});

  final String body;

  @override
  Widget build(BuildContext context) {
    final controller = useTextEditingController(text: body);
    final text = useValueListenable(controller);
    return AlertDialog(
      title: const Text('Edit queued message'),
      content: TextField(
        key: const ValueKey('agent-dm-queued-edit'),
        controller: controller,
        autofocus: true,
        maxLines: null,
        minLines: 3,
        decoration: const InputDecoration(labelText: 'Your queued message'),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        TextButton(
          onPressed: text.text.trim().isEmpty
              ? null
              : () => Navigator.of(context).pop(controller.text),
          child: const Text('Save'),
        ),
      ],
    );
  }
}
