import 'package:buzz/shared/surfaces/surface_chart.dart';
import 'package:buzz/shared/surfaces/surface_data.dart';
import 'package:buzz/shared/surfaces/surface_diff.dart';
import 'package:buzz/shared/surfaces/surface_format.dart';
import 'package:buzz/shared/surfaces/surface_markdown.dart';
import 'package:buzz/shared/surfaces/surface_media.dart';
import 'package:buzz/shared/surfaces/surface_model.dart';
import 'package:buzz/shared/surfaces/surface_rules.dart';
import 'package:flutter_test/flutter_test.dart';

const _id = '0b5c1f7e-8a7d-4d1e-9a51-3c2f1e0d9b88';

Surface _surface({
  required List<Map<String, Object?>> components,
  Map<String, Object?> data = const {},
  Map<String, Object?> trust = const {},
}) => decodeSurface({
  'id': _id,
  'spec': {
    'root': 'root',
    'components': components,
    'data': data,
    'dataTrust': trust,
  },
})!;

void main() {
  group('chart value axis (79 M2)', () {
    test('a value too large for a step to move still ends', () {
      for (final kind in ['line', 'bar', 'area', 'scatter']) {
        final geometry = surfaceChartGeometry(
          kind: kind,
          rows: const [
            {'x': 'a', 'y': 1e17},
          ],
          x: 'x',
          series: const [(key: 'y', label: 'Y')],
        );
        expect(geometry.empty, isFalse, reason: kind);
        expect(geometry.yTicks.length, lessThanOrEqualTo(11), reason: kind);
        expect(geometry.yTicks, isNotEmpty, reason: kind);
        for (final tick in geometry.yTicks) {
          expect(tick.at.isFinite, isTrue, reason: kind);
        }
      }
    });

    test('a step that can\'t move the axis falls back to its two ends', () {
      final scale = surfaceChartScale(1e17, 1e17 + 1);
      expect(scale.ticks.length, lessThanOrEqualTo(11));
      expect(scale.max, greaterThan(scale.min));
      final normal = surfaceChartScale(0, 87);
      expect(normal.ticks.first, 0);
      expect(normal.ticks.last, greaterThanOrEqualTo(87));
      expect(normal.ticks.length, lessThanOrEqualTo(surfaceChartMaxTicks + 1));
      final odd = surfaceChartScale(double.nan, double.infinity);
      expect(odd.ticks.every((v) => v.isFinite), isTrue);
    });
  });

  group('markdown limits (79 S2)', () {
    test('headings parse without a backtracking pattern', () {
      final blocks = parseMarkdown('## Title ##\n\n### Tags # here\n\n#nope');
      expect(mdInlineText((blocks[0] as MdHeading).children), 'Title');
      expect(mdInlineText((blocks[1] as MdHeading).children), 'Tags # here');
      expect(blocks[2], isA<MdParagraph>());
    });

    test('many unclosed openers stay literal text', () {
      final text = '[' * 5000 + '*' * 5000 + '`' * 5000;
      final blocks = parseMarkdown(text);
      expect(blocks.single, isA<MdParagraph>());
      expect(
        mdInlineText((blocks.single as MdParagraph).children).length,
        greaterThanOrEqualTo(10000),
      );
    });

    test('a closing marker past the scan cap is not matched', () {
      final far = '**${'a' * 600}**';
      final inline = parseMdInline(far);
      expect(inline.whereType<MdSpan>(), isEmpty);
      expect(parseMdInline('**near**').single, isA<MdSpan>());
    });

    test('one text parses at most the budget', () {
      final blocks = parseMarkdown('x' * (mdParseBudget + 500));
      expect(
        mdInlineText((blocks.single as MdParagraph).children).length,
        mdParseBudget,
      );
    });
  });

  group('node cap', () {
    test('a repeat that would draw over 2000 parts is too big', () {
      final surface = _surface(
        components: const [
          {
            'id': 'root',
            'type': 'Stack',
            'props': {
              'children': {'template': 'row', 'path': '/rows'},
            },
          },
          {
            'id': 'row',
            'type': 'Stack',
            'props': {
              'children': {'template': 'cell', 'path': 'cells'},
            },
          },
          {
            'id': 'cell',
            'type': 'Text',
            'props': {'text': 'x'},
          },
        ],
        data: {
          'rows': [
            for (var i = 0; i < 100; i++)
              {
                'cells': [for (var j = 0; j < 30; j++) j],
              },
          ],
        },
      );
      expect(surfaceNodeCount(surface), greaterThan(surfaceMaxNodes));
    });

    test('a small surface counts every part once', () {
      final surface = _surface(
        components: const [
          {
            'id': 'root',
            'type': 'Stack',
            'props': {
              'children': ['a', 'b'],
            },
          },
          {
            'id': 'a',
            'type': 'Text',
            'props': {'text': 'A'},
          },
          {
            'id': 'b',
            'type': 'Tabs',
            'props': {
              'items': [
                {'title': 'One', 'child': 'a'},
              ],
            },
          },
        ],
      );
      expect(surfaceNodeCount(surface), 4);
    });
  });

  group('outside content (79 S5)', () {
    test('any binding under an untrusted path, at any depth, counts', () {
      final surface = _surface(
        components: const [
          {
            'id': 'root',
            'type': 'KeyValue',
            'props': {
              'items': [
                {
                  'label': 'From',
                  'value': {'path': '/email/from'},
                },
              ],
            },
          },
        ],
        trust: const {'/email': 'external_untrusted'},
      );
      final component = surface.components['root']!;
      expect(readsUntrusted(surface, component, rootPointer), isTrue);
      final clean = _surface(
        components: const [
          {
            'id': 'root',
            'type': 'Text',
            'props': {
              'text': {'path': '/intro'},
            },
          },
        ],
        trust: const {'/email': 'external_untrusted'},
      );
      expect(
        readsUntrusted(clean, clean.components['root']!, rootPointer),
        isFalse,
      );
      // Drawn inside an untrusted item's scope.
      expect(
        readsUntrusted(clean, clean.components['root']!, const ['email', '0']),
        isTrue,
      );
    });
  });

  group('diff budget (79 S4)', () {
    test('a surface\'s diffs share one cell budget and are memoized', () {
      final memo = SurfaceDiffMemo();
      final before = List.generate(900, (i) => 'w$i').join(' ');
      final after = List.generate(900, (i) => 'v$i').join(' ');
      // 1799 x 1799 tokens: about 3.2M cells, more than one diff may use.
      final first = memo.diff(before, after);
      expect(first.map((part) => part.kind), [
        SurfaceDiffKind.removed,
        SurfaceDiffKind.added,
      ]);
      final small = memo.diff('the red fox', 'the blue fox');
      expect(
        identical(small, memo.diff('the red fox', 'the blue fox')),
        isTrue,
      );
      expect(
        small.where((part) => part.kind == SurfaceDiffKind.same),
        isNotEmpty,
      );
    });

    test('past the surface budget a diff is a whole replace', () {
      final memo = SurfaceDiffMemo();
      bool matchedAny(List<SurfaceDiffPart> parts) =>
          parts.any((part) => part.kind == SurfaceDiffKind.same);
      // About 490k cells each: within one diff's cap, so each spends budget.
      List<SurfaceDiffPart> round(int n) => memo.diff(
        List.generate(350, (i) => 'a$n$i').join(' '),
        List.generate(350, (i) => 'b$n$i').join(' '),
      );
      expect(matchedAny(round(0)), isTrue);
      final rounds = [for (var n = 1; n < 12; n++) round(n)];
      expect(matchedAny(rounds.last), isFalse);
    });
  });

  test('images may declare at most 4096 x 4096 pixels (79 S3)', () {
    expect(isDrawableImageSize(4096, 4096), isTrue);
    expect(isDrawableImageSize(4097, 4096), isFalse);
    expect(isDrawableImageSize(100000, 1), isTrue);
    expect(isDrawableImageSize(0, 10), isFalse);
  });

  test('currency codes are three capital letters', () {
    expect(formatSurfaceCurrency(5, 'usd'), '5');
    expect(formatSurfaceCurrency(5, 'US\u202eD'), '5');
    expect(formatSurfaceCurrency(5, 'USD'), contains('5'));
  });
}
