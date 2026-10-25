/// Agent text is plain text: control characters and bidi overrides are
/// dropped and lengths capped, as every Kiingo surface renderer does. Links
/// open only https and Kiingo deep links (R10).
library;

import 'surface_data.dart';

const _bidi = {
  0x200e,
  0x200f,
  0x202a,
  0x202b,
  0x202c,
  0x202d,
  0x202e,
  0x2066,
  0x2067,
  0x2068,
  0x2069,
};

/// Controls and bidi overrides removed (newlines kept when [lines]), at most
/// [max] characters.
String cleanText(String text, int max, {bool lines = false}) {
  final out = StringBuffer();
  for (final code in text.runes) {
    if (_bidi.contains(code)) continue;
    if (code == 0x0a) {
      out.write(lines ? '\n' : ' ');
      continue;
    }
    if (code == 0x09) {
      out.write(' ');
      continue;
    }
    if (code < 0x20 || (code >= 0x7f && code < 0xa0)) continue;
    out.writeCharCode(code);
  }
  final chars = out.toString().runes.toList();
  if (chars.length <= max) return out.toString();
  return '${String.fromCharCodes(chars.take(max - 1))}…';
}

/// A whole number without ".0"; otherwise the shortest form.
String formatPlainNumber(num value) {
  if (value is int) return '$value';
  if (value == value.truncateToDouble() && value.abs() < 1e15) {
    return '${value.toInt()}';
  }
  final rounded = double.parse(value.toStringAsPrecision(12));
  return rounded == rounded.truncateToDouble() && rounded.abs() < 1e15
      ? '${rounded.toInt()}'
      : '$rounded';
}

/// A string or number as clean, trimmed text; null when empty.
String? plainText(Object? value, int max, {bool lines = false}) {
  String? raw;
  if (value is String) {
    raw = value;
  } else if (value is num && value.isFinite) {
    raw = formatPlainNumber(value);
  }
  if (raw == null) return null;
  final text = cleanText(raw, max, lines: lines).trim();
  return text.isEmpty ? null : text;
}

/// Ids: printable ASCII without spaces, at most 200 characters.
String? plainId(Object? value) {
  final raw = value is String
      ? value
      : value is int
      ? '$value'
      : null;
  if (raw == null || raw.isEmpty || raw.length > 200) return null;
  for (final code in raw.codeUnits) {
    if (code <= 0x20 || code >= 0x7f) return null;
  }
  return raw;
}

/// Kiingo's own deep-link schemes (R10).
const kiingoSchemes = {'kiingo', 'kiingotasks', 'kiingolink'};

/// Hosts Kiingo counts as its own: links there open without the
/// outside-link confirmation.
const kiingoOwnHosts = ['kiingo.com'];

final _whitespace = RegExp(r'\s');

/// What `open`, Link and Markdown links may open (R10): https with a host
/// and no credentials, or a Kiingo deep link. Anything else is plain text.
String? openableUrl(Object? raw) {
  if (raw is! String) return null;
  final text = raw.trim();
  // A backslash is a path separator to browsers but not to Uri: refused, so
  // the host checked here is the host that opens.
  if (text.isEmpty ||
      text.length > 2048 ||
      _whitespace.hasMatch(text) ||
      text.contains(r'\')) {
    return null;
  }
  final uri = Uri.tryParse(text);
  if (uri == null || !uri.hasScheme) return null;
  final scheme = uri.scheme.toLowerCase();
  if (scheme == 'https') {
    return uri.host.isNotEmpty && uri.userInfo.isEmpty ? text : null;
  }
  return kiingoSchemes.contains(scheme) ? text : null;
}

/// Not a Kiingo deep link and not on a Kiingo host: confirmed before
/// opening.
bool isOutsideUrl(String raw, {List<String> ownHosts = kiingoOwnHosts}) {
  final uri = Uri.tryParse(raw);
  if (uri == null) return true;
  final scheme = uri.scheme.toLowerCase();
  if (scheme != 'https') return !kiingoSchemes.contains(scheme);
  final host = uri.host.toLowerCase();
  return !ownHosts.any((own) => host == own || host.endsWith('.$own'));
}

/// The host of a URL for the "Open this host?" question, else the URL.
String urlHost(String raw) {
  final host = Uri.tryParse(raw)?.host ?? '';
  return host.isEmpty ? raw : host;
}

const _secretWords = [
  'password',
  'passcode',
  'passphrase',
  'api key',
  'apikey',
  'token',
  '2fa',
  'two-factor',
  'one-time',
  'otp',
  'verification code',
  'mfa',
  'pin',
  'ssn',
  'social security',
  'card number',
  'cvv',
  'cvc',
  'routing number',
  'account number',
  'secret',
];

final _letter = RegExp(r'\p{L}', unicode: true);

bool _isLetterAt(String text, int index) =>
    index >= 0 && index < text.length && _letter.hasMatch(text[index]);

/// Texts that ask for a secret (§10, R11). Such an input is never drawn;
/// the server refuses them too. Short words match whole words only ("pin"
/// is not in "pinned").
bool asksForSecret(Iterable<String?> texts) => texts.any((raw) {
  if (raw == null || raw.isEmpty) return false;
  final text = raw.toLowerCase();
  return _secretWords.any((word) {
    var from = 0;
    while (true) {
      final at = text.indexOf(word, from);
      if (at < 0) return false;
      if (word.length > 3) return true;
      if (!_isLetterAt(text, at - 1) && !_isLetterAt(text, at + word.length)) {
        return true;
      }
      from = at + 1;
    }
  });
});

final _tags = RegExp('<[^>]*>');
final _nameBreaks = RegExp(r'[\s@._-]+');

/// Initials from a name ("Dana Lee" → "DL").
String initialsOf(String name) {
  final parts = name
      .replaceAll(_tags, ' ')
      .split(_nameBreaks)
      .where((part) => part.isNotEmpty)
      .take(2)
      .map((part) => String.fromCharCode(part.runes.first))
      .join();
  return parts.isEmpty ? '?' : parts.toUpperCase();
}

/// A number from a string or number prop.
num? numberOf(Object? value) => asNumber(value);
