import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';

import '../../../shared/agent_dm/agent_dm_markers.dart';
import '../../../shared/theme/theme.dart';

const _transcriptHeader = '\n\nTranscript\n';

/// The summary and transcript of a call card's readable content: the head
/// (`Call · N min`, then the summary) and everything after `Transcript`.
({String summary, String? transcript}) splitAgentDmCallContent(String content) {
  final at = content.indexOf(_transcriptHeader);
  final head = at < 0 ? content : content.substring(0, at);
  final transcript = at < 0
      ? null
      : content.substring(at + _transcriptHeader.length).trim();
  // The head starts with the server's own "Call · N min" line; the card
  // shows its title from the tag, so only the summary below it is kept.
  final parts = head.split('\n\n');
  final summary =
      (parts.length > 1 && parts.first.startsWith('Call ·')
              ? parts.skip(1).join('\n\n')
              : head)
          .trim();
  return (
    summary: summary,
    transcript: transcript == null || transcript.isEmpty ? null : transcript,
  );
}

/// A recorded voice call in an agent DM: a collapsed card with the call's
/// length and summary, and "Show transcript" to read the whole call.
class AgentDmCallCardRow extends HookWidget {
  /// The call marker.
  final AgentDmCall call;

  /// The event's readable content (summary and transcript).
  final String content;

  const AgentDmCallCardRow({
    super.key,
    required this.call,
    required this.content,
  });

  @override
  Widget build(BuildContext context) {
    final expanded = useState(false);
    final parts = splitAgentDmCallContent(content);
    final transcript = parts.transcript;
    final muted = context.colors.onSurfaceVariant;
    final direction = call.direction == AgentDmCallDirection.outbound
        ? 'Agent called you'
        : 'You called';
    return Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: Grid.gutter,
        vertical: Grid.xxs,
      ),
      child: DecoratedBox(
        key: const ValueKey('agent-dm-call-card'),
        decoration: BoxDecoration(
          color: context.controlSurface,
          borderRadius: BorderRadius.circular(Radii.lg),
        ),
        child: Padding(
          padding: const EdgeInsets.all(Grid.xs),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Semantics(
                header: true,
                child: Row(
                  children: [
                    Icon(Icons.call_outlined, size: 16, color: muted),
                    const SizedBox(width: Grid.half),
                    Text(call.title, style: context.textTheme.titleSmall),
                    const SizedBox(width: Grid.half),
                    Flexible(
                      child: Text(
                        direction,
                        overflow: TextOverflow.ellipsis,
                        style: context.textTheme.labelSmall?.copyWith(
                          color: muted,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              if (parts.summary.isNotEmpty) ...[
                const SizedBox(height: Grid.half),
                SelectableText(
                  parts.summary,
                  style: context.textTheme.bodyMedium,
                ),
              ],
              if (transcript != null) ...[
                if (expanded.value) ...[
                  const SizedBox(height: Grid.xxs),
                  SelectableText(
                    transcript,
                    key: const ValueKey('agent-dm-call-transcript'),
                    style: context.textTheme.bodySmall?.copyWith(color: muted),
                  ),
                ],
                Align(
                  alignment: Alignment.centerLeft,
                  child: TextButton(
                    key: const ValueKey('agent-dm-call-transcript-toggle'),
                    onPressed: () => expanded.value = !expanded.value,
                    child: Text(
                      expanded.value ? 'Hide transcript' : 'Show transcript',
                    ),
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
