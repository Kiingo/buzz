/// Chart geometry for the Chart component, as the Kiingo renderers compute
/// it, in plain numbers the view paints. Colours are palette slots (0-7)
/// the app maps to its own theme; agents never set colours.
library;

import 'dart:math' as math;
import 'dart:ui' show Offset, Rect;

import 'surface_data.dart';
import 'surface_format.dart';
import 'surface_text.dart';

/// Chart kinds this version draws.
const surfaceChartKinds = {
  'line',
  'bar',
  'stackedBar',
  'area',
  'pie',
  'donut',
  'scatter',
  'sparkline',
};

/// Palette slots.
const surfaceChartSlots = 8;

/// One series to plot.
typedef SurfaceChartSeriesInput = ({String key, String label});

/// A labelled position on an axis.
typedef SurfaceChartTick = ({double at, String label});

/// One series' marks.
class SurfaceChartSeries {
  final String label;
  final int slot;
  final List<Rect> bars = [];
  final List<Offset> points = [];

  /// Drawn as a line (line, area, sparkline).
  bool line = false;

  /// Filled down to [baseline] (area).
  bool area = false;
  double baseline = 0;

  SurfaceChartSeries(this.label, this.slot);
}

/// One slice of a pie or donut, angles in radians clockwise from 12 o'clock.
typedef SurfaceChartSlice = ({
  double start,
  double sweep,
  String label,
  num value,
  int slot,
  double share,
});

/// Everything the view paints.
class SurfaceChartGeometry {
  final double width;
  final double height;
  final Rect plot;
  final List<SurfaceChartTick> xTicks;
  final List<SurfaceChartTick> yTicks;
  final List<SurfaceChartSeries> series;
  final List<SurfaceChartSlice> slices;

  /// Inner radius as a share of the radius (donut), else 0.
  final double hole;
  final ({double y, String label})? goal;
  final bool empty;

  /// A text summary for screen readers.
  final String summary;

  const SurfaceChartGeometry({
    required this.width,
    required this.height,
    required this.plot,
    this.xTicks = const [],
    this.yTicks = const [],
    this.series = const [],
    this.slices = const [],
    this.hole = 0,
    this.goal,
    required this.empty,
    required this.summary,
  });
}

double _niceStep(double span, int count) {
  final raw = span / math.max(1, count);
  final power = math
      .pow(10, (math.log(raw == 0 ? 1 : raw) / math.ln10).floor())
      .toDouble();
  final scaled = raw / power;
  final nice = scaled <= 1
      ? 1
      : scaled <= 2
      ? 2
      : scaled <= 5
      ? 5
      : 10;
  return nice * power;
}

/// The series of a component's `series` prop.
/// Most value-axis ticks drawn.
const surfaceChartMaxTicks = 10;

/// The value axis for values from [low] to [high]: rounded ends and at most
/// [surfaceChartMaxTicks] + 1 ticks. When a step can't move a number this
/// large (or isn't a real step), the axis is just its two ends, so tick
/// loops always stop.
({double min, double max, List<double> ticks}) surfaceChartScale(
  double low,
  double high,
) {
  var min = low.isFinite ? low : 0.0;
  var max = high.isFinite ? high : min;
  if (max <= min) max = min + (min.abs() > 0 ? min.abs() : 1);
  // Still equal: the gap is below double precision at this size.
  if (max <= min) return (min: min, max: min + 1, ticks: [min, min + 1]);
  final step = _niceStep(max - min, 4);
  if (!step.isFinite || step <= 0 || min + step == min || max + step == max) {
    return (min: min, max: max, ticks: [min, max]);
  }
  final yMin = (min / step).floorToDouble() * step;
  final yMax = (max / step).ceilToDouble() * step;
  final count = ((yMax - yMin) / step).round();
  if (!yMin.isFinite ||
      !yMax.isFinite ||
      yMax <= yMin ||
      count < 1 ||
      count > surfaceChartMaxTicks) {
    return (min: min, max: max, ticks: [min, max]);
  }
  return (
    min: yMin,
    max: yMax,
    ticks: [for (var i = 0; i <= count; i++) yMin + i * step],
  );
}

List<SurfaceChartSeriesInput> surfaceChartSeriesOf(Object? raw) => [
  if (raw is List)
    for (final item in raw)
      if (asObject(item) case final object?)
        if (asString(object['key']) case final key? when key.isNotEmpty)
          (key: key, label: plainText(object['label'], 40) ?? key),
];

/// The geometry of a chart [width] × [height] (defaults per kind).
SurfaceChartGeometry surfaceChartGeometry({
  required String kind,
  required List<Object?> rows,
  required String x,
  required List<SurfaceChartSeriesInput> series,
  String? xType,
  String? valueFormat,
  String? currency,
  num? goal,
  double? width,
  double? height,
}) {
  final sparkline = kind == 'sparkline';
  final w = width ?? (sparkline ? 160 : 560);
  final h = height ?? (sparkline ? 36 : 220);
  final round = kind == 'pie' || kind == 'donut';
  final plotted = (round ? series.take(1) : series.take(surfaceChartSlots))
      .toList();
  final records = [for (final row in rows.take(500)) ?asObject(row)];
  String fmt(num value) => formatSurfaceValue(value, valueFormat, currency);
  final empty = SurfaceChartGeometry(
    width: w,
    height: h,
    plot: Rect.fromLTRB(0, 0, w, h),
    empty: true,
    summary: 'No data',
  );
  if (records.isEmpty || plotted.isEmpty) return empty;
  String labelOf(Map<String, Object?> row) {
    final raw = row[x];
    if (xType == 'time') {
      final date = parseSurfaceDate(raw);
      if (date != null) return formatSurfaceShortDate(date);
    }
    final text = cellText(raw);
    return text.isEmpty ? '—' : text;
  }

  if (round) {
    final key = plotted.first.key;
    final values = [
      for (final row in records) math.max<num>(0, asNumber(row[key]) ?? 0),
    ];
    final total = values.fold<num>(0, (sum, value) => sum + value);
    if (total <= 0) return empty;
    var angle = 0.0;
    final slices = <SurfaceChartSlice>[];
    for (var index = 0; index < records.length; index++) {
      final share = values[index] / total;
      slices.add((
        start: angle,
        sweep: share * math.pi * 2,
        label: labelOf(records[index]),
        value: values[index],
        slot: index % surfaceChartSlots,
        share: share,
      ));
      angle += share * math.pi * 2;
    }
    return SurfaceChartGeometry(
      width: w,
      height: h,
      plot: Rect.fromLTRB(0, 0, w, h),
      slices: slices,
      hole: kind == 'donut' ? 0.55 : 0,
      empty: false,
      summary: slices
          .map(
            (s) => '${s.label}: ${fmt(s.value)} (${(s.share * 100).round()}%)',
          )
          .join('; '),
    );
  }

  final plot = sparkline
      ? Rect.fromLTRB(2, 2, w - 2, h - 2)
      : Rect.fromLTRB(52, 12, w - 12, h - 28);
  final stacked = kind == 'stackedBar';
  final barLike = kind == 'bar' || stacked;
  final values = [
    for (final row in records) [for (final s in plotted) asNumber(row[s.key])],
  ];
  num low = 0;
  num high = 0;
  for (final rowValues in values) {
    if (stacked) {
      high = math.max(
        high,
        rowValues.fold<num>(0, (sum, v) => sum + math.max(0, v ?? 0)),
      );
      low = math.min(
        low,
        rowValues.fold<num>(0, (sum, v) => sum + math.min(0, v ?? 0)),
      );
    } else {
      for (final v in rowValues) {
        if (v != null) {
          high = math.max(high, v);
          low = math.min(low, v);
        }
      }
    }
  }
  if (goal != null) {
    high = math.max(high, goal);
    low = math.min(low, goal);
  }
  if (!barLike && !sparkline) {
    // Lines need not start at zero, but keep zero in view when close.
    final present = [
      for (final rowValues in values)
        for (final v in rowValues) ?v,
      ?goal,
    ];
    if (present.isNotEmpty) {
      final least = present.reduce(math.min);
      if (least > 0 && least > high * 0.5) low = least - (high - least) * 0.1;
    }
  }
  if (high == low) high = low + 1;
  final scale = surfaceChartScale(low.toDouble(), high.toDouble());
  final yMin = scale.min;
  final yMax = scale.max;
  double y(num value) =>
      plot.bottom - ((value - yMin) / (yMax - yMin)) * plot.height;

  final numeric = xType == 'number' || xType == 'time';
  final xs = [
    for (final row in records)
      xType == 'time'
          ? parseSurfaceDate(row[x])?.millisecondsSinceEpoch
          : asNumber(row[x]),
  ];
  final useScale =
      numeric && !barLike && xs.every((v) => v != null) && records.length > 1;
  final xMin = useScale ? xs.map((v) => v!).reduce(math.min) : 0;
  final xMax = useScale ? xs.map((v) => v!).reduce(math.max) : 0;
  final band = plot.width / records.length;
  double xAt(int index) {
    if (useScale && xMax > xMin) {
      return plot.left + ((xs[index]! - xMin) / (xMax - xMin)) * plot.width;
    }
    if (barLike) return plot.left + band * (index + 0.5);
    if (records.length == 1) return plot.center.dx;
    return plot.left + (index / (records.length - 1)) * plot.width;
  }

  final geometry = [
    for (var slot = 0; slot < plotted.length; slot++)
      SurfaceChartSeries(plotted[slot].label, slot),
  ];
  final stackPos = List<num>.filled(records.length, 0);
  final stackNeg = List<num>.filled(records.length, 0);
  for (var index = 0; index < records.length; index++) {
    for (var slot = 0; slot < plotted.length; slot++) {
      final value = values[index][slot];
      if (value == null) continue;
      final g = geometry[slot];
      if (barLike) {
        final inner = band * 0.72;
        if (stacked) {
          final base = value >= 0 ? stackPos[index] : stackNeg[index];
          final top = base + value;
          if (value >= 0) {
            stackPos[index] = top;
          } else {
            stackNeg[index] = top;
          }
          g.bars.add(
            Rect.fromLTRB(
              xAt(index) - inner / 2,
              math.min(y(base), y(top)),
              xAt(index) + inner / 2,
              math.max(y(base), y(top)),
            ),
          );
        } else {
          final each = inner / plotted.length;
          final left = xAt(index) - inner / 2 + each * slot;
          g.bars.add(
            Rect.fromLTRB(
              left,
              math.min(y(0), y(value)),
              left + math.max(1, each - 1),
              math.max(y(0), y(value)),
            ),
          );
        }
      } else {
        g.points.add(Offset(xAt(index), y(value)));
      }
    }
  }
  if (!barLike) {
    for (final g in geometry) {
      if (g.points.isEmpty) continue;
      g.line = kind != 'scatter';
      if (kind == 'area') {
        g.area = true;
        g.baseline = y(math.max(yMin, math.min(0, yMax)));
      }
    }
  }
  final yTicks = <SurfaceChartTick>[];
  final xTicks = <SurfaceChartTick>[];
  if (!sparkline) {
    for (final v in scale.ticks) {
      yTicks.add((
        at: y(v),
        label: fmt(double.parse(v.toStringAsPrecision(10))),
      ));
    }
    final every = math.max(1, (records.length / 8).ceil());
    for (var index = 0; index < records.length; index += every) {
      xTicks.add((at: xAt(index), label: labelOf(records[index])));
    }
  }
  final summary = [
    for (var slot = 0; slot < plotted.length; slot++)
      '${plotted[slot].label}: ${[for (var index = 0; index < records.length && index < 24; index++)
        if (values[index][slot] case final value?) '${labelOf(records[index])} ${fmt(value)}'].join(', ')}${records.length > 24 ? ', …' : ''}',
  ].join('; ');
  return SurfaceChartGeometry(
    width: w,
    height: h,
    plot: plot,
    xTicks: xTicks,
    yTicks: yTicks,
    series: geometry,
    goal: goal == null ? null : (y: y(goal), label: 'Goal ${fmt(goal)}'),
    empty: false,
    summary: summary,
  );
}
