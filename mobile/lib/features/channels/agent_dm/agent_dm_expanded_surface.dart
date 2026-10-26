import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../../../shared/surfaces/agent_surface_view.dart';
import '../../../shared/surfaces/surface_client.dart';
import '../../../shared/surfaces/surface_host.dart';
import '../../../shared/surfaces/surface_model.dart';
import '../../../shared/theme/theme.dart';

/// The agent card in the large sheet, following the same read as the
/// message. Every read is checked again (79 S-b): a read that no longer
/// names [signer]'s key draws nothing, even with the sheet open.
class AgentDmExpandedSurface extends ConsumerWidget {
  /// The card's id and the revision its message named.
  final ({String id, int revision}) surfaceKey;

  /// Who signed the message the sheet was opened from (lowercase).
  final String signer;

  /// What the app does for the card.
  final SurfaceHost host;

  const AgentDmExpandedSurface({
    super.key,
    required this.surfaceKey,
    required this.signer,
    required this.host,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final loaded = ref.watch(agentSurfaceProvider(surfaceKey)).value;
    if (loaded == null || !surfaceFromSigner(loaded.surface, signer)) {
      return const SizedBox.shrink();
    }
    return SingleChildScrollView(
      padding: const EdgeInsets.all(Grid.xs),
      child: AgentSurfaceView(loaded: loaded, host: host, expanded: true),
    );
  }
}
