import 'package:flutter/material.dart';

import '../../../shared/agent_dm/agent_dm_markers.dart';
import '../../../shared/theme/theme.dart';

/// A full-width "New session" or "Earlier session loaded" divider with the
/// agent's acknowledgement as its caption.
class AgentDmSessionDividerRow extends StatelessWidget {
  /// The divider marker.
  final AgentDmSessionDivider divider;

  /// The event's content: one acknowledgement sentence.
  final String caption;

  const AgentDmSessionDividerRow({
    super.key,
    required this.divider,
    required this.caption,
  });

  @override
  Widget build(BuildContext context) {
    final text = caption.trim();
    final color = context.colors.onSurfaceVariant;
    final line = Expanded(
      child: Divider(
        height: 1,
        thickness: 1,
        color: context.colors.outlineVariant,
      ),
    );
    return Semantics(
      container: true,
      label: text.isEmpty ? divider.label : '${divider.label}. $text',
      excludeSemantics: true,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: Grid.xxs),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              children: [
                line,
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: Grid.xxs),
                  child: Text(
                    divider.label,
                    key: const ValueKey('agent-dm-divider-label'),
                    style: context.textTheme.labelMedium?.copyWith(
                      color: color,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                line,
              ],
            ),
            if (text.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: Grid.half),
                child: Text(
                  text,
                  key: const ValueKey('agent-dm-divider-caption'),
                  textAlign: TextAlign.center,
                  maxLines: 3,
                  overflow: TextOverflow.ellipsis,
                  style: context.textTheme.bodySmall?.copyWith(color: color),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
