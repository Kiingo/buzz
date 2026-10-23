/// Finds link-like prose that is not written as a Markdown link: bare domains
/// (`kiingo.com/x`), `www.` hosts, email addresses and clearly formatted
/// phone numbers. Scheme URLs (`https://…`, `buzz://…`) are out of scope:
/// `normalizeBareLinks` already owns them.
///
/// Mirrors desktop `findBareLinks` (`desktop/src/shared/lib/bareLinks.ts`).
/// Both run the case table in `test-fixtures/bare-links.json`; the spec is
/// `docs/bare-links.md`. Desktop checks TLDs with linkifyjs; this uses an
/// allowlist of the TLDs people actually write.
library;

enum BareLinkKind { url, www, email, phone }

class BareLink {
  const BareLink({
    required this.start,
    required this.end,
    required this.text,
    required this.href,
    required this.kind,
  });

  final int start;
  final int end;
  final String text;
  final String href;
  final BareLinkKind kind;
}

/// TLDs that are also common file extensions. A bare `name.<tld>` with one of
/// these is a filename unless it has `www.` or a path, query or fragment.
/// Must equal `fileExtensionTlds` in `test-fixtures/bare-links.json`.
const fileExtensionTlds = {
  'ac',
  'am',
  'app',
  'cc',
  'in',
  'json',
  'md',
  'ml',
  'mov',
  'pl',
  'pm',
  'ps',
  'py',
  'rs',
  'sh',
  'so',
  'tf',
  'ts',
  'zip',
};

/// TLDs a bare domain may end in. Generic TLDs in common use plus the
/// country codes people write; the file-extension TLDs are included so the
/// filename rule (not a missing TLD) decides them.
const _tlds = [
  // Generic.
  'com', 'net', 'org', 'edu', 'gov', 'mil', 'int', 'info', 'biz', 'name',
  'pro', 'io', 'ai', 'app', 'dev', 'page', 'xyz', 'tech', 'cloud', 'site',
  'online', 'store', 'shop', 'blog', 'news', 'live', 'media', 'link', 'chat',
  'social', 'art', 'design', 'studio', 'agency', 'email', 'systems',
  'network', 'software', 'solutions', 'services', 'tools', 'works', 'world',
  'team', 'company', 'group', 'global', 'digital', 'academy', 'health',
  'finance', 'capital', 'ventures', 'events', 'travel', 'money', 'law',
  'bio', 'eco', 'zone', 'one', 'run', 'build', 'codes', 'wiki', 'help',
  'support', 'today', 'life', 'fun', 'mov', 'zip',
  // Country codes.
  'ac', 'ae', 'am', 'ar', 'at', 'au', 'be', 'bg', 'br', 'by', 'ca', 'cc',
  'ch', 'cl', 'cn', 'co', 'cz', 'de', 'dk', 'ee', 'eg', 'es', 'eu', 'fi',
  'fm', 'fr', 'gg', 'gr', 'hk', 'hr', 'hu', 'id', 'ie', 'il', 'in', 'is',
  'it', 'jp', 'ke', 'kr', 'lt', 'lu', 'lv', 'ly', 'ma', 'md', 'me', 'ml',
  'mx', 'my', 'ng', 'nl', 'no', 'nz', 'ph', 'pk', 'pl', 'pm', 'ps', 'pt',
  'py', 'ro', 'rs', 'ru', 'sa', 'se', 'sg', 'sh', 'si', 'sk', 'so', 'tf',
  'th', 'tr', 'tv', 'tw', 'ua', 'uk', 'us', 'uy', 'vn', 'ws', 'za',
];

final _tldAlternation =
    (_tlds.toSet().toList()..sort((a, b) => b.length.compareTo(a.length))).join(
      '|',
    );

const _label = r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';

/// Start of text, whitespace or an opener: `( [ { < " ' * _ ~`.
const _allowedPreceding = r'''(?<=^|[\s(\[{<"'*_~])''';

final _domainPattern = RegExp(
  '$_allowedPreceding(?:$_label\\.)+(?:$_tldAlternation)'
  r'(?::\d{2,5})?(?![a-z0-9\-@]|\.[a-z0-9])(?:[/?#][^\s<>\[\]`]*)?',
  caseSensitive: false,
);

final _emailPattern = RegExp(
  '$_allowedPreceding[a-z0-9][a-z0-9._%+\\-]*@(?:$_label\\.)+'
  '(?:$_tldAlternation)(?![a-z0-9\\-]|\\.[a-z0-9])',
  caseSensitive: false,
);

/// Same source as desktop `PHONE_PATTERN`.
final _phonePattern = RegExp(
  r'(?<![\w+.\-/])(?:\+\d{1,3}[ .-]?\(?\d{1,4}\)?(?:[ .-]?\d{2,4}){2,4}|\(\d{3}\) ?\d{3}-\d{4}|\d{3}-\d{3}-\d{4}|\d{3}\.\d{3}\.\d{4})(?![\w\-/]|\.\d)',
);

final _trailingPunctuation = RegExp(r'''[.,:;!?'"*_~]''');
const _closers = {')': '(', ']': '[', '}': '{'};

/// Peels trailing punctuation and unbalanced closing brackets.
String peelTrailing(String text) {
  var value = text;
  while (value.isNotEmpty) {
    final last = value[value.length - 1];
    if (_trailingPunctuation.hasMatch(last)) {
      value = value.substring(0, value.length - 1);
      continue;
    }
    final opener = _closers[last];
    if (opener != null &&
        opener.allMatches(value).length < last.allMatches(value).length) {
      value = value.substring(0, value.length - 1);
      continue;
    }
    break;
  }
  return value;
}

BareLinkKind? _classifyHost(String value) {
  final hostEnd = value.indexOf(RegExp(r'[/?#:]'));
  final host = (hostEnd < 0 ? value : value.substring(0, hostEnd))
      .toLowerCase();
  if (!host.contains('.')) return null;
  final tld = host.substring(host.lastIndexOf('.') + 1);
  if (host.startsWith('www.')) return BareLinkKind.www;
  final hasPath = RegExp(r'[/?#]').hasMatch(value.substring(host.length));
  if (!hasPath && fileExtensionTlds.contains(tld)) return null;
  return BareLinkKind.url;
}

/// All bare links in [text], in order, with no overlaps.
List<BareLink> findBareLinks(String text) {
  final found = <BareLink>[];

  for (final match in _emailPattern.allMatches(text)) {
    final value = match[0]!;
    found.add(
      BareLink(
        start: match.start,
        end: match.end,
        text: value,
        href: 'mailto:$value',
        kind: BareLinkKind.email,
      ),
    );
  }

  for (final match in _domainPattern.allMatches(text)) {
    final value = peelTrailing(match[0]!);
    final kind = _classifyHost(value);
    if (kind == null) continue;
    found.add(
      BareLink(
        start: match.start,
        end: match.start + value.length,
        text: value,
        href: 'https://$value',
        kind: kind,
      ),
    );
  }

  for (final match in _phonePattern.allMatches(text)) {
    final value = match[0]!;
    final digits = value.replaceAll(RegExp(r'\D'), '');
    if (digits.length < 8 || digits.length > 15) continue;
    found.add(
      BareLink(
        start: match.start,
        end: match.end,
        text: value,
        href: 'tel:${value.startsWith('+') ? '+' : ''}$digits',
        kind: BareLinkKind.phone,
      ),
    );
  }

  found.sort((a, b) => a.start != b.start ? a.start - b.start : b.end - a.end);
  final result = <BareLink>[];
  for (final link in found) {
    if (result.isNotEmpty && link.start < result.last.end) continue;
    result.add(link);
  }
  return result;
}
