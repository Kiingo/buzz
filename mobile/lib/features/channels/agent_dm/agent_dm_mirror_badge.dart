import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../../../shared/agent_dm/agent_dm_markers.dart';
import '../../../shared/theme/theme.dart';
import '../channel_identity_names_provider.dart';

/// The badge line above a mirrored message: "via email" and, when the
/// claimed author is not a usable DM member, "Relayed by" and the signer's name.
class AgentDmMirrorBadge extends ConsumerWidget {
  /// The mirror marker.
  final AgentDmMirror mirror;

  /// The DM, for the signer's contextual name.
  final String channelId;

  /// The signer of the mirror event.
  final String signerPubkey;

  /// Whether to say who relayed the message.
  final bool relayed;

  const AgentDmMirrorBadge({
    super.key,
    required this.mirror,
    required this.channelId,
    required this.signerPubkey,
    required this.relayed,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final signerName = relayed
        ? watchChannelIdentityLabel(ref, channelId, signerPubkey.toLowerCase())
        : null;
    final muted = context.colors.onSurfaceVariant;
    final relayedLabel = signerName == null ? null : 'Relayed by $signerName';
    return Semantics(
      container: true,
      label: [mirror.badgeLabel, ?relayedLabel].join(', '),
      excludeSemantics: true,
      child: Padding(
        padding: const EdgeInsets.only(left: Grid.xs, bottom: Grid.quarter),
        child: Wrap(
          spacing: Grid.half,
          runSpacing: Grid.quarter,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
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
                child: Text(
                  mirror.badgeLabel,
                  style: context.textTheme.labelSmall?.copyWith(color: muted),
                ),
              ),
            ),
            if (relayedLabel != null)
              Text(
                relayedLabel,
                key: const ValueKey('agent-dm-mirror-relayed'),
                style: context.textTheme.labelSmall?.copyWith(color: muted),
              ),
          ],
        ),
      ),
    );
  }
}
