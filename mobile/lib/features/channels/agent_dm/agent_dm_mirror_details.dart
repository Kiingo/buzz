import 'package:flutter/material.dart';

import '../../../shared/agent_dm/agent_dm_markers.dart';
import '../../../shared/theme/theme.dart';

/// The original time of a mirrored message, in local time.
String agentDmMirrorOriginalTime(AgentDmMirror mirror) {
  final at = DateTime.fromMillisecondsSinceEpoch(
    mirror.originalAt * 1000,
    isUtc: true,
  ).toLocal();
  return at.toString();
}

/// The Details-sheet section for a mirrored message: where it came from,
/// its original time and, for email, its subject.
class AgentDmMirrorDetails extends StatelessWidget {
  /// The mirror marker.
  final AgentDmMirror mirror;

  const AgentDmMirrorDetails({super.key, required this.mirror});

  @override
  Widget build(BuildContext context) {
    final subject = mirror.subject;
    return Column(
      key: const ValueKey('agent-dm-mirror-details'),
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('Mirrored message', style: context.textTheme.titleSmall),
        const SizedBox(height: Grid.half),
        Text(
          'Copied into this conversation ${mirror.badgeLabel}.',
          style: context.textTheme.bodySmall,
        ),
        _Line(label: 'Original time', value: agentDmMirrorOriginalTime(mirror)),
        if (subject != null) _Line(label: 'Subject', value: subject),
        const SizedBox(height: Grid.xs),
      ],
    );
  }
}

class _Line extends StatelessWidget {
  final String label;
  final String value;

  const _Line({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    return ListTile(
      contentPadding: EdgeInsets.zero,
      dense: true,
      title: Text(label, style: context.textTheme.labelSmall),
      subtitle: SelectableText(value, style: context.textTheme.bodySmall),
    );
  }
}
