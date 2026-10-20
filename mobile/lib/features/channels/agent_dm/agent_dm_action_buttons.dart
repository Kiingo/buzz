import 'package:flutter/material.dart';

import '../../../shared/agent_dm/agent_dm_markers.dart';
import '../../../shared/theme/theme.dart';

/// Up to three `buzz-action` buttons under an agent message. The primary
/// action is a filled button; the others are outlined.
class AgentDmActionButtons extends StatelessWidget {
  /// The buttons, in tag order.
  final List<AgentDmAction> actions;

  /// Whether taps are accepted. False while one is sending and for good once
  /// one was sent.
  final bool enabled;

  /// Sends [AgentDmAction.sendText] with the action's ref.
  final ValueChanged<AgentDmAction> onTap;

  const AgentDmActionButtons({
    super.key,
    required this.actions,
    required this.enabled,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: Grid.half, left: Grid.xs),
      child: Wrap(
        spacing: Grid.half,
        runSpacing: Grid.half,
        children: [
          for (final action in actions)
            Semantics(
              key: ValueKey('agent-dm-action-${action.actionId}'),
              container: true,
              button: true,
              enabled: enabled,
              label: action.label,
              excludeSemantics: true,
              onTap: enabled ? () => onTap(action) : null,
              child: action.primary
                  ? FilledButton(
                      onPressed: enabled ? () => onTap(action) : null,
                      child: Text(action.label),
                    )
                  : OutlinedButton(
                      onPressed: enabled ? () => onTap(action) : null,
                      child: Text(action.label),
                    ),
            ),
        ],
      ),
    );
  }
}
