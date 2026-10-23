import 'dart:convert';
import 'dart:io';

import 'package:buzz/features/channels/message_content/bare_links.dart';
import 'package:buzz/features/channels/message_content/link_normalizer.dart';
import 'package:flutter_test/flutter_test.dart';

// Shared with desktop `bareLinks.test.mjs`; `flutter test` runs in `mobile/`.
final _table =
    jsonDecode(File('../test-fixtures/bare-links.json').readAsStringSync())
        as Map<String, dynamic>;

void main() {
  test('file-extension TLDs match the shared table', () {
    expect(
      fileExtensionTlds,
      (_table['fileExtensionTlds'] as List).cast<String>().toSet(),
    );
  });

  group('shared case table', () {
    for (final raw in _table['cases'] as List) {
      final testCase = raw as Map<String, dynamic>;
      test(testCase['name'] as String, () {
        final input = testCase['input'] as String;
        final found = findBareLinks(input);
        expect(
          [
            for (final link in found)
              {'text': link.text, 'href': link.href, 'kind': link.kind.name},
          ],
          [
            for (final link in testCase['links'] as List)
              Map<String, String>.from(link as Map),
          ],
        );
        for (final link in found) {
          expect(input.substring(link.start, link.end), link.text);
        }
      });
    }
  });

  group('peelTrailing', () {
    test('drops trailing punctuation and unbalanced closers', () {
      expect(peelTrailing('kiingo.com).'), 'kiingo.com');
      expect(peelTrailing('a.com/x_(y)'), 'a.com/x_(y)');
      expect(peelTrailing('a.com/x]'), 'a.com/x');
    });
  });

  group('normalizeBareLinks', () {
    test('links bare domains, emails and phones in prose', () {
      expect(
        normalizeBareLinks('See kiingo.com, alex@example.com or 555-123-4567.'),
        'See [kiingo.com](https://kiingo.com), '
        '[alex@example.com](mailto:alex@example.com) or '
        '[555-123-4567](tel:5551234567).',
      );
    });

    test('escapes Markdown-significant destination characters', () {
      expect(
        normalizeBareLinks('en.wikipedia.org/wiki/Mercury_(planet)'),
        '[en.wikipedia.org/wiki/Mercury_(planet)]'
        '(https://en.wikipedia.org/wiki/Mercury_%28planet%29)',
      );
    });

    test('leaves inline and fenced code alone', () {
      expect(
        normalizeBareLinks('run `curl kiingo.com` now'),
        'run `curl kiingo.com` now',
      );
      expect(
        normalizeBareLinks('```\nkiingo.com\n```'),
        '```\nkiingo.com\n```',
      );
    });

    test('never links inside an existing link', () {
      expect(
        normalizeBareLinks('[kiingo.com docs](https://docs.kiingo.com/a)'),
        '[kiingo.com docs](https://docs.kiingo.com/a)',
      );
      expect(
        normalizeBareLinks('https://kiingo.com/x and www.example.com'),
        '[https://kiingo.com/x](https://kiingo.com/x) and '
        '[www.example.com](https://www.example.com)',
      );
    });

    test('leaves filenames, versions and mentions alone', () {
      const text = 'edit README.md for 1.2.3, cc @kiingo.com';
      expect(normalizeBareLinks(text), text);
    });
  });
}
