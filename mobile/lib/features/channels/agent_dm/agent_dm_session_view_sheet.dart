import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../../../shared/agent_dm/agent_dm_session_views.dart';
import '../../../shared/theme/theme.dart';
import '../../../shared/widgets/modal_presentation.dart';

/// Opens one read-only view of the reader's own session: a screen, the files
/// it changed, or their own queued messages (each with Withdraw).
Future<void> showAgentDmSessionViewSheet(
  BuildContext context,
  String agentPubkey,
  AgentDmSessionView view,
) => showBuzzModalBottomSheet<void>(
  context: context,
  title: switch (view.kind) {
    'files' => 'Files changed',
    'queued' => 'Queued messages',
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
            for (final row in section.rows) _ScreenRow(row: row),
        ],
      ];
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
              trailing: TextButton(
                onPressed: withdrawing.value == null
                    ? () => unawaited(withdraw(message.messageId))
                    : null,
                child: const Text('Withdraw'),
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

class _ScreenRow extends StatelessWidget {
  const _ScreenRow({required this.row});

  final AgentDmScreenRow row;

  @override
  Widget build(BuildContext context) {
    final muted = context.textTheme.bodySmall?.copyWith(
      color: context.colors.onSurfaceVariant,
    );
    final mono = context.textTheme.bodySmall?.copyWith(
      fontFamily: 'monospace',
    );
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
              if (row.value case final value?)
                Text(value, style: muted),
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
    final mono = context.textTheme.bodySmall?.copyWith(
      fontFamily: 'monospace',
    );
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
