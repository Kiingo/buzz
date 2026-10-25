/// Agent text is plain text: control characters and characters that draw
/// nothing (Unicode Cf: bidi overrides, zero-width spaces and joiners, word
/// joiners, BOMs, interlinear annotations; every default-ignorable code
/// point: variation selectors, U+034F, U+17B4/5, Mongolian selectors,
/// Hangul fillers; tag characters) are dropped and lengths capped, as every
/// Kiingo surface renderer does (79 S1). Links open only https and allowed
/// Kiingo deep links (R10).
library;

import 'surface_data.dart';

/// Characters that draw nothing: Default_Ignorable_Code_Point (which holds
/// the variation selectors U+FE00–FE0F and U+E0100–E01EF, U+034F,
/// U+17B4/5, U+180B–180F and the Hangul fillers), Cf and the tags
/// U+E0000–E007F.
final _invisible = RegExp(
  r'[\p{Default_Ignorable_Code_Point}\p{Cf}\u{E0000}-\u{E007F}'
  r'\u115F\u1160\u3164\uFFA0]',
  unicode: true,
);

/// The one invisible character an agent's words may hold: a single emoji
/// presentation selector (U+FE0F) right after a pictograph ("❤️"). It only
/// picks the emoji glyph; a run of selectors (hidden data) still counts.
final _emojiPresentation = RegExp(
  r'(\p{Extended_Pictographic})\uFE0F(?![\uFE00-\uFE0F\u{E0100}-\u{E01EF}])',
  unicode: true,
);

bool _isInvisible(int code) => _invisible.hasMatch(String.fromCharCode(code));

/// Whether [text] holds a character that draws nothing (S1), other than one
/// emoji presentation selector after a pictograph.
bool hasInvisibleText(Object? text) =>
    text is String &&
    _invisible.hasMatch(
      text.replaceAllMapped(_emojiPresentation, (match) => match[1]!),
    );

/// [text] without the characters that draw nothing.
String withoutInvisible(String text) => text.replaceAll(_invisible, '');

/// The compatibility forms that stand in for ASCII, folded the way NFKC
/// folds them (this app has no Unicode normaliser): fullwidth forms, the
/// ideographic space, small form variants and mathematical letters and
/// digits. `ｐａｓｓｗｏｒｄ`, `﹫dana` and `𝐩𝐚𝐬𝐬` read as ASCII.
String foldCompatibilityForms(String text) {
  final out = StringBuffer();
  for (final code in text.runes) {
    out.writeCharCode(_foldCode(code));
  }
  return out.toString();
}

const _smallForms = {
  0xfe50: 0x2c,
  0xfe51: 0x3001,
  0xfe52: 0x2e,
  0xfe54: 0x3b,
  0xfe55: 0x3a,
  0xfe56: 0x3f,
  0xfe57: 0x21,
  0xfe59: 0x28,
  0xfe5a: 0x29,
  0xfe5b: 0x7b,
  0xfe5c: 0x7d,
  0xfe5f: 0x23,
  0xfe60: 0x26,
  0xfe61: 0x2a,
  0xfe62: 0x2b,
  0xfe63: 0x2d,
  0xfe64: 0x3c,
  0xfe65: 0x3e,
  0xfe66: 0x3d,
  0xfe68: 0x5c,
  0xfe69: 0x24,
  0xfe6a: 0x25,
  0xfe6b: 0x40,
};

int _foldCode(int code) {
  if (code >= 0xff01 && code <= 0xff5e) return code - 0xff01 + 0x21;
  if (code == 0x3000) return 0x20;
  final small = _smallForms[code];
  if (small != null) return small;
  // Mathematical alphanumeric letters: 13 alphabets of A–Z then a–z.
  if (code >= 0x1d400 && code <= 0x1d6a3) {
    final at = (code - 0x1d400) % 52;
    return at < 26 ? 0x41 + at : 0x61 + at - 26;
  }
  // Mathematical digits: 5 sets of 0–9.
  if (code >= 0x1d7ce && code <= 0x1d7ff) return 0x30 + (code - 0x1d7ce) % 10;
  return code;
}

/// The form two texts are compared in (secret words, a tap's words):
/// compatibility forms folded, nothing invisible, lower case.
/// `pass\u200Bword` and `ｐａｓｓｗｏｒｄ` both read "password".
String comparableText(String text) =>
    withoutInvisible(foldCompatibilityForms(text)).toLowerCase();

/// LF, CR, NEL, LINE SEPARATOR and PARAGRAPH SEPARATOR.
const _lineBreakCodes = {0x0a, 0x0d, 0x85, 0x2028, 0x2029};

/// Controls and invisible characters removed (newlines kept when [lines]),
/// at most [max] characters.
String cleanText(String text, int max, {bool lines = false}) {
  final out = StringBuffer();
  var afterCr = false;
  for (final code in text.runes) {
    // Every line break is a "\n" (79 M1): CRLF once; CR, LF, NEL, LS and
    // PS each. Nothing else breaks a line, so every rule that looks for
    // "\n" sees every break.
    final crlf = afterCr && code == 0x0a;
    afterCr = code == 0x0d;
    if (crlf) continue;
    if (_lineBreakCodes.contains(code)) {
      out.write(lines ? '\n' : ' ');
      continue;
    }
    if (code == 0x09) {
      out.write(' ');
      continue;
    }
    if (code < 0x20 || (code >= 0x7f && code < 0xa0)) continue;
    if (_isInvisible(code)) continue;
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

/// The deep-link routes a surface may open (79 W10): ones that only show
/// something. Anything that starts a call, adds, pairs or enrolls (every
/// `kiingolink:` route) is plain text, and every deep link is still
/// confirmed before it opens.
const kiingoDeepLinkRoutes = {
  'kiingo': ['artifact', 'artifacts', 'open', 'task'],
  'kiingotasks': ['task', 'agent', 'queue'],
};

final _deepLinkRoute = RegExp(
  r'^[a-z]+://([a-z0-9_-]+)(?:[/?#]|$)',
  caseSensitive: false,
);

bool _isAllowedDeepLink(String scheme, String text) {
  final route = _deepLinkRoute.firstMatch(text)?.group(1)?.toLowerCase();
  final routes = kiingoDeepLinkRoutes[scheme] ?? const <String>[];
  return route != null && routes.contains(route);
}

final _whitespace = RegExp(r'\s');

/// What `open`, Link and Markdown links may open (R10): https with a host
/// and no credentials (as parsed, so the URL shown is the URL opened), or
/// an allowed Kiingo deep link. Anything else is plain text.
String? openableUrl(Object? raw) {
  if (raw is! String) return null;
  final text = raw.trim();
  // A backslash is a path separator to browsers but not to Uri: refused, so
  // the host checked here is the host that opens. Invisible and bidi
  // characters could make the shown URL differ from the one opened.
  if (text.isEmpty ||
      text.length > 2048 ||
      _whitespace.hasMatch(text) ||
      text.contains(r'\') ||
      hasInvisibleText(text)) {
    return null;
  }
  final uri = Uri.tryParse(text);
  if (uri == null || !uri.hasScheme) return null;
  final scheme = uri.scheme.toLowerCase();
  if (scheme == 'https') {
    return uri.host.isNotEmpty && uri.userInfo.isEmpty ? uri.toString() : null;
  }
  return kiingoSchemes.contains(scheme) && _isAllowedDeepLink(scheme, text)
      ? text
      : null;
}

/// Whether a link is confirmed before it opens (§5, 79 W10): everything
/// except the host app's own origins ([ownOrigins]). Buzz has none, so
/// every link, Kiingo hosts and deep links included, is confirmed.
bool isOutsideUrl(String raw, {List<String> ownOrigins = const []}) {
  final uri = Uri.tryParse(raw);
  if (uri == null || uri.scheme.toLowerCase() != 'https') return true;
  return !ownOrigins.any((own) {
    final ownUri = Uri.tryParse(own);
    return ownUri != null &&
        ownUri.scheme.toLowerCase() == 'https' &&
        ownUri.host.toLowerCase() == uri.host.toLowerCase() &&
        ownUri.port == uri.port;
  });
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
  final text = comparableText(raw);
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
