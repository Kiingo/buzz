import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../theme/buzz_icons.dart';
import '../theme/theme.dart';
import '../widgets/modal_presentation.dart';
import 'surface_chart.dart';
import 'surface_client.dart';
import 'surface_data.dart';
import 'surface_diff.dart';
import 'surface_format.dart';
import 'surface_host.dart';
import 'surface_markdown.dart';
import 'surface_media.dart';
import 'surface_model.dart';
import 'surface_rules.dart';
import 'surface_sends.dart';
import 'surface_text.dart';

part 'agent_surface_view/actions.dart';
part 'agent_surface_view/chart.dart';
part 'agent_surface_view/data.dart';
part 'agent_surface_view/display.dart';
part 'agent_surface_view/display_media.dart';
part 'agent_surface_view/footer.dart';
part 'agent_surface_view/inputs.dart';
part 'agent_surface_view/inputs_pickers.dart';
part 'agent_surface_view/layout.dart';
part 'agent_surface_view/markdown.dart';
part 'agent_surface_view/node.dart';
part 'agent_surface_view/scope.dart';
part 'agent_surface_view/sent.dart';
part 'agent_surface_view/ui.dart';

/// An agent surface (`kiingo.ui/v1`) drawn view only, with the same meaning
/// as the Kiingo apps: "from" the agent, the title, the components, then
/// the server's status and the view-only line. Everything the agent wrote
/// is plain text in the app's own styles; outside content is quoted; images
/// come only through the signed proxy; secret inputs are never drawn; run
/// buttons say "Open in the Kiingo app".
class AgentSurfaceView extends StatelessWidget {
  /// The surface and the host it came from.
  final LoadedSurface loaded;

  /// What the app does for it.
  final SurfaceHost host;

  /// Drawn in the large sheet rather than under a message.
  final bool expanded;

  const AgentSurfaceView({
    super.key,
    required this.loaded,
    required this.host,
    this.expanded = false,
  });

  @override
  Widget build(BuildContext context) {
    final surface = loaded.surface;
    final scope = _SurfaceContext(
      surface: surface,
      origin: loaded.origin,
      host: host,
      expanded: expanded,
    );
    // Named from the message signer's profile (79), never the surface.
    final agentName = host.agentName ?? 'your agent';
    final over = isOver(surface) && !expanded;
    final known = isKnownCatalog(surface);
    final collapsed = surface.display == SurfaceDisplay.expanded && !expanded;
    final muted = context.colors.onSurfaceVariant;
    final sent = known ? sentEmailOf(surface) : null;
    final Widget body;
    if (sent != null && sentEmailIsPlain(surface)) {
      // Dismissed or closed: a plain Sent, nothing more (79).
      body = Row(
        children: [
          Icon(
            _toneIcon('success'),
            size: 16,
            color: _toneColor(context, 'success'),
          ),
          const SizedBox(width: Grid.half),
          Text('Sent', style: TextStyle(color: muted)),
        ],
      );
    } else if (sent != null) {
      // Sent (Ross, 2026-10-31): a compact row whatever the state, that
      // opens to what was sent, read-only.
      body = _SentEmailRow(
        sent: sent,
        initiallyOpen: expanded,
        child: _Node(componentId: surface.root, scope: rootPointer, depth: 0),
      );
    } else if (over) {
      body = Text(
        surface.state == SurfaceState.dismissed ? 'Dismissed' : 'Closed',
        style: context.textTheme.bodyMedium?.copyWith(color: muted),
      );
    } else if (!known) {
      body = _NewerAppNotice(webUrl: surface.webUrl);
    } else if (surfaceNodeCount(surface) > surfaceMaxNodes) {
      body = _NewerAppNotice(webUrl: surface.webUrl, tooBig: true);
    } else if (collapsed) {
      body = Align(
        alignment: AlignmentDirectional.centerStart,
        child: _SurfaceButton(
          label: 'Open',
          semanticLabel:
              'Open ${surface.title.isEmpty ? 'this' : surface.title} in full',
          onPressed: host.openExpanded,
        ),
      );
    } else {
      body = Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          _Node(componentId: surface.root, scope: rootPointer, depth: 0),
          if (unknownTypes(surface).isNotEmpty) ...[
            const SizedBox(height: Grid.xxs),
            _NewerAppNotice(webUrl: surface.webUrl),
          ],
        ],
      );
    }
    drawSurfaceRevision(surface.id, surface.revision);
    // This revision's tap settle starts when it is first on screen (79).
    return _SettleOnShow(
      surface: surface,
      child: _SurfaceScope(
        data: scope,
        child: Semantics(
          container: true,
          label: surface.title.isEmpty ? 'Card from $agentName' : surface.title,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                'from $agentName',
                style: bodyExtraSmallTextStyle.copyWith(color: muted),
              ),
              if (surface.title.isNotEmpty) ...[
                const SizedBox(height: Grid.quarter),
                Semantics(
                  header: true,
                  child: Text(
                    surface.title,
                    style: context.textTheme.bodyMedium?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
              const SizedBox(height: Grid.xxs),
              body,
              const _Footer(),
            ],
          ),
        ),
      ),
    );
  }
}
