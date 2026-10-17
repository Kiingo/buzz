import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../shared/clipboard_utils.dart';
import '../../shared/theme/theme.dart';
import '../../shared/widgets/modal_presentation.dart';
import 'reply_details.dart';
import 'timeline_message.dart';

/// Long-press -> Details: what used to clutter the chat (the mission link,
/// steering and Stop) plus the message's own identifiers.
Future<void> showMessageDetailsSheet(
  BuildContext context,
  TimelineMessage message,
) {
  return showBuzzModalBottomSheet<void>(
    context: context,
    title: 'Message details',
    isScrollControlled: true,
    builder: (sheetContext) => MessageDetailsSheet(message: message),
  );
}

class MessageDetailsSheet extends StatelessWidget {
  final TimelineMessage message;

  const MessageDetailsSheet({super.key, required this.message});

  @override
  Widget build(BuildContext context) {
    final details = readReplyDetails(message.tags);
    final sentAt = DateTime.fromMillisecondsSinceEpoch(
      message.createdAt * 1000,
    ).toLocal();
    final detailsUrl = details.detailsUrl;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          Grid.gutter,
          0,
          Grid.gutter,
          Grid.xs,
        ),
        child: Column(
          key: const ValueKey('message-details-sheet'),
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (details.hasMission) ...[
              Text('Kiingo mission', style: context.textTheme.titleSmall),
              const SizedBox(height: Grid.half),
              Text(
                'Reply in this thread to steer the agent. Open the mission to '
                'see its status or stop it.',
                style: context.textTheme.bodySmall,
              ),
              if (details.missionId != null)
                _DetailTile(label: 'Mission ID', value: details.missionId!),
              if (detailsUrl != null)
                Padding(
                  padding: const EdgeInsets.only(top: Grid.xs),
                  child: FilledButton.icon(
                    key: const ValueKey('message-details-open-mission'),
                    icon: const Icon(LucideIcons.externalLink),
                    label: const Text('Open mission in Kiingo'),
                    onPressed: () => unawaited(
                      launchUrl(
                        detailsUrl,
                        mode: LaunchMode.externalApplication,
                      ),
                    ),
                  ),
                ),
              const SizedBox(height: Grid.xs),
            ],
            _DetailTile(label: 'Event ID', value: message.id),
            _DetailTile(label: 'Author key', value: message.pubkey),
            _DetailTile(
              label: 'Sent',
              value: sentAt.toString(),
              copyable: false,
            ),
          ],
        ),
      ),
    );
  }
}

class _DetailTile extends StatelessWidget {
  final String label;
  final String value;
  final bool copyable;

  const _DetailTile({
    required this.label,
    required this.value,
    this.copyable = true,
  });

  @override
  Widget build(BuildContext context) {
    return ListTile(
      contentPadding: EdgeInsets.zero,
      dense: true,
      title: Text(label, style: context.textTheme.labelSmall),
      subtitle: SelectableText(value, style: context.textTheme.bodySmall),
      trailing: copyable
          ? IconButton(
              tooltip: 'Copy ${label.toLowerCase()}',
              icon: const Icon(LucideIcons.copy, size: 18),
              onPressed: () => unawaited(
                copyToClipboard(context, value, message: '$label copied'),
              ),
            )
          : null,
    );
  }
}
