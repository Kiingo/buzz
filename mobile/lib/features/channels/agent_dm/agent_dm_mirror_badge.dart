import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../../../shared/theme/theme.dart';
import '../channel_identity_names_provider.dart';
import '../timeline_message.dart';
import 'agent_dm_timeline.dart';

/// The relay line above a mirrored message, from the shared display rule:
/// the `via <surface>` badge and, for a requester mirror, a relay glyph and
/// `relayed by <agent>`. Always visible; a claimed name is never shown as
/// the author.
class AgentDmMirrorBadge extends ConsumerWidget {
  /// The DM's indexed markers.
  final AgentDmTimeline timeline;

  /// The mirrored message.
  final TimelineMessage message;

  /// The DM, for contextual names.
  final String channelId;

  const AgentDmMirrorBadge({
    super.key,
    required this.timeline,
    required this.message,
    required this.channelId,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final display = timeline.mirrorDisplayOf(
      message,
      (pubkey) => watchChannelIdentityLabel(ref, channelId, pubkey),
    );
    if (display == null) return const SizedBox.shrink();
    final muted = context.colors.onSurfaceVariant;
    final style = context.textTheme.labelSmall?.copyWith(color: muted);
    final badge = display.mirror.badgeLabel;
    return Semantics(
      container: true,
      label: display.relayLine,
      excludeSemantics: true,
      child: Padding(
        padding: const EdgeInsets.only(left: Grid.xs, bottom: Grid.quarter),
        child: Wrap(
          spacing: Grid.half,
          runSpacing: Grid.quarter,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            if (display.relayed)
              Icon(
                Icons.forward_outlined,
                key: const ValueKey('agent-dm-mirror-relay-glyph'),
                size: 14,
                color: muted,
              ),
            DecoratedBox(
              key: const ValueKey('agent-dm-mirror-badge'),
              decoration: BoxDecoration(
                color: context.controlSurface,
                borderRadius: BorderRadius.circular(Radii.full),
              ),
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: Grid.half + Grid.quarter,
                  vertical: Grid.quarter,
                ),
                child: Text(badge, style: style),
              ),
            ),
            if (display.relayed)
              Text(
                'relayed by ${display.relayedByName}',
                key: const ValueKey('agent-dm-mirror-relayed'),
                style: style,
              ),
          ],
        ),
      ),
    );
  }
}
