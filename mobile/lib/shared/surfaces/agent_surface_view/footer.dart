part of '../agent_surface_view.dart';

/// The server's status, who changed it last, and the view-only line with
/// "Open in Kiingo" wherever the surface would take a change.
class _Footer extends StatelessWidget {
  const _Footer();

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    final surface = scope.surface;
    final status = surface.status;
    final note = editedNote(surface, agentName: scope.agentName);
    final viewOnly =
        !isOver(surface) && (acceptsEdits(surface) || acceptsTaps(surface));
    final webUrl = surface.webUrl;
    if (status == null && note == null && !viewOnly) {
      return const SizedBox.shrink();
    }
    final toneName = status?.tone.name;
    final meta = context.textTheme.labelSmall?.copyWith(
      color: context.colors.onSurfaceVariant,
    );
    return Padding(
      padding: const EdgeInsets.only(top: Grid.xxs + Grid.quarter),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          if (status != null)
            Semantics(
              liveRegion: true,
              child: Row(
                children: [
                  Icon(
                    _toneIcon(toneName),
                    size: 14,
                    color: _toneColor(context, toneName),
                  ),
                  const SizedBox(width: Grid.half),
                  Expanded(
                    child: Text(
                      status.text,
                      style: _small(
                        context,
                        color: _toneColor(context, toneName),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          if (note != null) Text(note, style: meta),
          if (viewOnly)
            Wrap(
              crossAxisAlignment: WrapCrossAlignment.center,
              spacing: Grid.xxs,
              children: [
                Text(viewOnlyHint, style: meta),
                if (webUrl != null)
                  _SurfaceButton(
                    label: 'Open in Kiingo',
                    style: SurfaceActionStyle.plain,
                    onPressed: () => scope.openLink(context, webUrl),
                  ),
              ],
            ),
        ],
      ),
    );
  }
}
