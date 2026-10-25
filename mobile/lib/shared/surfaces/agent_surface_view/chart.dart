part of '../agent_surface_view.dart';

// §4.2 Chart, painted from the shared geometry. Colours are the app's
// palette slots, never the agent's.

List<Color> _chartPalette(BuildContext context) {
  final colors = context.colors;
  final app = context.appColors;
  return [
    colors.primary,
    app.success,
    app.warning,
    colors.tertiary,
    colors.outline,
    app.success.withValues(alpha: 0.6),
    app.warning.withValues(alpha: 0.6),
    colors.primary.withValues(alpha: 0.6),
  ];
}

class _ChartView extends StatelessWidget {
  final _NodeProps p;
  const _ChartView(this.p);

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    final rawKind = scope.string(p.component, 'kind');
    final kind = surfaceChartKinds.contains(rawKind) ? rawKind! : 'bar';
    final sparkline = kind == 'sparkline';
    final caption =
        scope.text(p.component, 'caption', p.scope, max: 200) ??
        scope.text(p.component, 'unit', p.scope, max: 20) ??
        scope.text(p.component, 'currency', p.scope, max: 20);
    final palette = _chartPalette(context);
    final muted = context.colors.onSurfaceVariant;
    return LayoutBuilder(
      builder: (context, constraints) {
        final width = constraints.maxWidth.isFinite
            ? constraints.maxWidth
            : 320.0;
        final geometry = surfaceChartGeometry(
          kind: kind,
          rows: scope.list(p.component, 'data', p.scope),
          x: scope.string(p.component, 'x') ?? 'x',
          series: surfaceChartSeriesOf(p.component.props['series']),
          xType: scope.string(p.component, 'xType'),
          valueFormat: scope.string(p.component, 'valueFormat'),
          currency: scope.string(p.component, 'currency'),
          goal: scope.number(p.component, 'goal', p.scope),
          width: width,
          height: sparkline ? 36 : 220,
        );
        if (geometry.empty) return Text('No data', style: _small(context));
        final legend = geometry.slices.isNotEmpty
            ? [for (final s in geometry.slices) (label: s.label, slot: s.slot)]
            : geometry.series.length > 1
            ? [for (final s in geometry.series) (label: s.label, slot: s.slot)]
            : const <({String label, int slot})>[];
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Semantics(
              image: true,
              label: geometry.summary,
              excludeSemantics: true,
              child: SizedBox(
                width: geometry.width,
                height: geometry.height,
                child: CustomPaint(
                  painter: _ChartPainter(
                    geometry: geometry,
                    kind: kind,
                    palette: palette,
                    muted: muted,
                    labelStyle:
                        context.textTheme.labelSmall ?? const TextStyle(),
                    textDirection: Directionality.of(context),
                  ),
                ),
              ),
            ),
            if (legend.isNotEmpty)
              ExcludeSemantics(
                child: Padding(
                  padding: const EdgeInsets.only(top: Grid.half + Grid.quarter),
                  child: Wrap(
                    spacing: Grid.twelve,
                    runSpacing: Grid.half,
                    children: [
                      for (final entry in legend)
                        Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Container(
                              width: 8,
                              height: 8,
                              decoration: BoxDecoration(
                                color: palette[entry.slot % palette.length],
                                borderRadius: BorderRadius.circular(
                                  Radii.xs / 2,
                                ),
                              ),
                            ),
                            const SizedBox(width: Grid.half),
                            Text(entry.label, style: _small(context)),
                          ],
                        ),
                    ],
                  ),
                ),
              ),
            if (caption != null)
              Text(
                caption,
                style: context.textTheme.labelSmall?.copyWith(color: muted),
              ),
          ],
        );
      },
    );
  }
}

class _ChartPainter extends CustomPainter {
  final SurfaceChartGeometry geometry;
  final String kind;
  final List<Color> palette;
  final Color muted;
  final TextStyle labelStyle;
  final TextDirection textDirection;

  const _ChartPainter({
    required this.geometry,
    required this.kind,
    required this.palette,
    required this.muted,
    required this.labelStyle,
    required this.textDirection,
  });

  Color _slot(int slot) => palette[slot % palette.length];

  void _label(
    Canvas canvas,
    String text,
    Offset at, {
    TextAlign align = TextAlign.center,
  }) {
    final clipped = text.length > 14 ? '${text.substring(0, 13)}…' : text;
    final painter = TextPainter(
      text: TextSpan(
        text: clipped,
        style: labelStyle.copyWith(color: muted, fontSize: 10),
      ),
      textDirection: textDirection,
      maxLines: 1,
    )..layout();
    final dx = switch (align) {
      TextAlign.right || TextAlign.end => at.dx - painter.width,
      TextAlign.left || TextAlign.start => at.dx,
      _ => at.dx - painter.width / 2,
    };
    painter.paint(canvas, Offset(dx, at.dy - painter.height / 2));
    painter.dispose();
  }

  @override
  void paint(Canvas canvas, Size size) {
    final g = geometry;
    final plot = g.plot;
    final grid = Paint()
      ..color = muted.withValues(alpha: 0.15)
      ..strokeWidth = 1;
    for (final tick in g.yTicks) {
      canvas.drawLine(
        Offset(plot.left, tick.at),
        Offset(plot.right, tick.at),
        grid,
      );
      _label(
        canvas,
        tick.label,
        Offset(plot.left - 6, tick.at),
        align: TextAlign.right,
      );
    }
    for (final tick in g.xTicks) {
      _label(canvas, tick.label, Offset(tick.at, plot.bottom + 14));
    }
    if (g.slices.isNotEmpty) {
      final radius = math.min(size.width, size.height) / 2 - 4;
      final center = Offset(size.width / 2, size.height / 2);
      final rect = Rect.fromCircle(center: center, radius: radius);
      for (final slice in g.slices) {
        final paint = Paint()..color = _slot(slice.slot);
        if (g.hole > 0) {
          paint
            ..style = PaintingStyle.stroke
            ..strokeWidth = radius * (1 - g.hole);
          canvas.drawArc(
            Rect.fromCircle(center: center, radius: radius * (1 + g.hole) / 2),
            slice.start - math.pi / 2,
            slice.sweep,
            false,
            paint,
          );
        } else {
          canvas.drawArc(
            rect,
            slice.start - math.pi / 2,
            slice.sweep,
            true,
            paint,
          );
        }
      }
    }
    final sparkline = kind == 'sparkline';
    for (final series in g.series) {
      final color = _slot(series.slot);
      if (series.points.isNotEmpty && (series.line || series.area)) {
        final path = Path()
          ..moveTo(series.points.first.dx, series.points.first.dy);
        for (final point in series.points.skip(1)) {
          path.lineTo(point.dx, point.dy);
        }
        if (series.area) {
          final fill = Path.from(path)
            ..lineTo(series.points.last.dx, series.baseline)
            ..lineTo(series.points.first.dx, series.baseline)
            ..close();
          canvas.drawPath(fill, Paint()..color = color.withValues(alpha: 0.18));
        }
        canvas.drawPath(
          path,
          Paint()
            ..color = color
            ..style = PaintingStyle.stroke
            ..strokeWidth = sparkline ? 1.5 : 2
            ..strokeJoin = StrokeJoin.round,
        );
      }
      for (final bar in series.bars) {
        canvas.drawRRect(
          RRect.fromRectAndRadius(bar, const Radius.circular(2)),
          Paint()..color = color,
        );
      }
      if (kind == 'scatter') {
        for (final point in series.points) {
          canvas.drawCircle(point, 3.5, Paint()..color = color);
        }
      }
    }
    final goal = g.goal;
    if (goal != null) {
      final dash = Paint()
        ..color = muted
        ..strokeWidth = 1;
      for (var x = plot.left; x < plot.right; x += 7) {
        canvas.drawLine(
          Offset(x, goal.y),
          Offset(math.min(x + 4, plot.right), goal.y),
          dash,
        );
      }
      _label(
        canvas,
        goal.label,
        Offset(plot.left + 4, goal.y - 8),
        align: TextAlign.left,
      );
    }
  }

  @override
  bool shouldRepaint(_ChartPainter oldDelegate) =>
      !identical(oldDelegate.geometry, geometry) ||
      oldDelegate.muted != muted ||
      oldDelegate.palette.first != palette.first;
}

/// A metric's trend line.
class _Sparkline extends StatelessWidget {
  final List<num> values;
  const _Sparkline({required this.values});

  @override
  Widget build(BuildContext context) {
    final palette = _chartPalette(context);
    return ExcludeSemantics(
      child: LayoutBuilder(
        builder: (context, constraints) {
          final geometry = surfaceChartGeometry(
            kind: 'sparkline',
            rows: [
              for (final (index, value) in values.take(200).indexed)
                {'x': index, 'y': value},
            ],
            x: 'x',
            series: const [(key: 'y', label: 'Trend')],
            xType: 'number',
            width: constraints.maxWidth.isFinite ? constraints.maxWidth : 160,
            height: 24,
          );
          return SizedBox(
            height: 24,
            width: double.infinity,
            child: CustomPaint(
              painter: _ChartPainter(
                geometry: geometry,
                kind: 'sparkline',
                palette: palette,
                muted: context.colors.onSurfaceVariant,
                labelStyle: const TextStyle(),
                textDirection: Directionality.of(context),
              ),
            ),
          );
        },
      ),
    );
  }
}
