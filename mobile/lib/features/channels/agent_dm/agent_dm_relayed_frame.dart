import 'package:flutter/material.dart';

import '../../../shared/theme/theme.dart';

/// The distinct relayed treatment for a requester mirror's body: an
/// outlined, muted frame. A relayed line is never drawn as the reader's own
/// outgoing bubble.
class AgentDmRelayedFrame extends StatelessWidget {
  /// Whether to draw the frame; otherwise [child] is returned as is.
  final bool relayed;

  /// The message body.
  final Widget child;

  const AgentDmRelayedFrame({
    super.key,
    required this.relayed,
    required this.child,
  });

  @override
  Widget build(BuildContext context) {
    if (!relayed) return child;
    return DecoratedBox(
      key: const ValueKey('agent-dm-relayed-frame'),
      decoration: BoxDecoration(
        border: Border.all(color: context.colors.outlineVariant),
        borderRadius: BorderRadius.circular(Radii.md),
      ),
      child: Padding(padding: const EdgeInsets.all(Grid.quarter), child: child),
    );
  }
}
