/// Display formatting for agent surfaces: numbers, money, dates and cell
/// text, locale-aware through `intl`. Times show in the device's zone (a
/// surface's `timeZone` is not applied here).
library;

import 'package:intl/intl.dart';

import 'surface_data.dart';
import 'surface_text.dart';

/// A number with at most two decimals.
String formatSurfaceNumber(num value) {
  try {
    return (NumberFormat.decimalPattern()..maximumFractionDigits = 2).format(
      value,
    );
  } catch (_) {
    return formatPlainNumber(value);
  }
}

/// Money in [currency] (ISO 4217), else the number and the code.
String formatSurfaceCurrency(num value, [String currency = 'USD']) {
  try {
    return NumberFormat.simpleCurrency(name: currency).format(value);
  } catch (_) {
    return '${formatSurfaceNumber(value)} $currency';
  }
}

/// A share; values over 1 are taken as already in percent.
String formatSurfacePercent(num value) {
  final share = value.abs() > 1 ? value / 100 : value;
  try {
    return (NumberFormat.percentPattern()..maximumFractionDigits = 1).format(
      share,
    );
  } catch (_) {
    return '${formatPlainNumber(value)}%';
  }
}

/// A value in a chart's or metric's format.
String formatSurfaceValue(num value, String? format, [String? currency]) =>
    switch (format) {
      'currency' => formatSurfaceCurrency(value, currency ?? 'USD'),
      'percent' => formatSurfacePercent(value),
      _ => formatSurfaceNumber(value),
    };

/// Bytes as "482 KB".
String formatSurfaceBytes(num bytes) {
  if (!bytes.isFinite || bytes < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  var value = bytes.toDouble();
  var unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  final text = unit == 0
      ? formatPlainNumber(value)
      : value.toStringAsFixed(value < 10 ? 1 : 0);
  return '$text ${units[unit]}';
}

final _dateOnly = RegExp(r'^\d{4}-\d{2}-\d{2}$');
final _timeOnly = RegExp(r'^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$');

/// A date-only string as local midnight; anything else as an ISO time.
DateTime? parseSurfaceDate(Object? value) {
  if (value is! String || value.isEmpty) return null;
  if (_dateOnly.hasMatch(value)) {
    final parts = value.split('-').map(int.parse).toList();
    return DateTime(parts[0], parts[1], parts[2]);
  }
  return DateTime.tryParse(value)?.toLocal();
}

/// A cell or prop date as text: date-only stays a date; times get a time.
String? formatSurfaceDate(Object? value) {
  if (value is String && _timeOnly.hasMatch(value)) {
    return value.substring(0, 5);
  }
  final date = parseSurfaceDate(value);
  if (date == null) return plainText(value, 200);
  if (value is String && _dateOnly.hasMatch(value)) {
    return DateFormat.yMMMd().format(date);
  }
  return DateFormat.yMMMd().add_jm().format(date);
}

/// "Tue, Oct 28" for grouping slots by day.
String formatSurfaceDay(DateTime date) => DateFormat.MMMEd().format(date);

/// "3:30 PM".
String formatSurfaceTime(DateTime date) => DateFormat.jm().format(date);

/// "Oct 28" for chart axes.
String formatSurfaceShortDate(DateTime date) => DateFormat.MMMd().format(date);

/// "2 h 14 min"; "less than a minute" under one.
String formatSurfaceDuration(Duration span) {
  final minutes = span.inMinutes.abs();
  if (minutes < 1) return 'less than a minute';
  final days = minutes ~/ 1440;
  final hours = (minutes % 1440) ~/ 60;
  final rest = minutes % 60;
  return [
    if (days > 0) '$days d',
    if (hours > 0) '$hours h',
    if (rest > 0 && days == 0) '$rest min',
  ].join(' ');
}

/// Countdown text: "in 2 h 14 min", "3 d ago", or "now".
String countdownText(DateTime target, {required bool since, DateTime? now}) {
  final delta = target.difference(now ?? DateTime.now());
  if (!since && delta.inSeconds.abs() < 60) return 'now';
  return delta.isNegative
      ? '${formatSurfaceDuration(delta)} ago'
      : 'in ${formatSurfaceDuration(delta)}';
}

/// Text for a table cell or list value of any shape.
String cellText(Object? value) {
  if (value is String || value is num) {
    return plainText(value, 500, lines: true) ?? '';
  }
  if (value is bool) return value ? 'Yes' : 'No';
  final object = asObject(value);
  if (object != null) {
    return plainText(
          object['title'] ??
              object['label'] ??
              object['text'] ??
              object['name'] ??
              object['email'],
          500,
        ) ??
        '';
  }
  if (value is List) {
    return value.map(cellText).where((text) => text.isNotEmpty).join(', ');
  }
  return '';
}

/// A rich text value (`{format, text}` or a plain string) as its Markdown.
String richTextOf(Object? value) {
  if (value is String) return value;
  final text = fieldOf(value, 'text');
  return text is String ? text : '';
}
