/// The safe Markdown subset surfaces carry (§3: emphasis, lists, links,
/// code, quotes; no raw HTML), parsed to a small tree the view draws with
/// its own widgets, so nothing is ever injected as markup. Raw HTML stays
/// literal text; links open only https and Kiingo deep links (R10),
/// anything else shows as its text. Bare URLs are not auto-linked.
library;

import 'dart:math' as math;

import 'surface_text.dart';

/// An inline node.
sealed class MdInline {
  const MdInline();
}

class MdText extends MdInline {
  final String text;
  const MdText(this.text);
}

/// `**strong**`, `*em*` or `~~del~~`.
class MdSpan extends MdInline {
  final MdSpanKind kind;
  final List<MdInline> children;
  const MdSpan(this.kind, this.children);
}

enum MdSpanKind { strong, em, del }

class MdCode extends MdInline {
  final String text;
  const MdCode(this.text);
}

class MdLink extends MdInline {
  final String href;
  final List<MdInline> children;
  const MdLink(this.href, this.children);
}

class MdBreak extends MdInline {
  const MdBreak();
}

/// A block node.
sealed class MdBlock {
  const MdBlock();
}

class MdParagraph extends MdBlock {
  final List<MdInline> children;
  const MdParagraph(this.children);
}

class MdHeading extends MdBlock {
  final int level;
  final List<MdInline> children;
  const MdHeading(this.level, this.children);
}

class MdList extends MdBlock {
  final bool ordered;
  final int start;
  final List<List<MdBlock>> items;
  const MdList({
    required this.ordered,
    required this.start,
    required this.items,
  });
}

class MdQuote extends MdBlock {
  final List<MdBlock> children;
  const MdQuote(this.children);
}

class MdCodeBlock extends MdBlock {
  final String? language;
  final String text;
  const MdCodeBlock(this.text, {this.language});
}

class MdRule extends MdBlock {
  const MdRule();
}

/// Most characters parsed from one Markdown text, and from one surface's
/// Markdown in all (past it, text shows plain).
const mdParseBudget = 20000;
const _maxNesting = 6;

/// How far a closing marker or bracket is looked for (79 S2): one pass per
/// opener, never to the end of a long text.
const _scanCap = 500;

/// How far a link's `(target)` may run (an https URL is at most 2048).
const _targetCap = 2100;

/// The index of [char] in [text] after [from], within [cap], else -1.
int _indexWithin(String text, String char, int from, int cap) {
  final end = math.min(text.length, from + cap);
  for (var i = from; i < end; i++) {
    if (text[i] == char) return i;
  }
  return -1;
}

final _escapable = RegExp(r'[\\`*_{}\[\]()#+\-.!~>|]');
final _word = RegExp(r'[\p{L}\p{N}]', unicode: true);
final _spaces = RegExp(r'\s+');

bool _isWordAt(String text, int index) =>
    index >= 0 && index < text.length && _word.hasMatch(text[index]);

int _findClosing(String text, int from, String marker) {
  var i = from;
  final stop = math.min(text.length, from + _scanCap);
  while (i < stop) {
    if (text[i] == r'\') {
      i += 2;
      continue;
    }
    if (text[i] == '`') {
      final end = _indexWithin(text, '`', i + 1, stop - i - 1);
      i = end < 0 ? i + 1 : end + 1;
      continue;
    }
    if (text.startsWith(marker, i) && i > from && text[i - 1] != ' ') {
      return i;
    }
    i++;
  }
  return -1;
}

int _findBracket(String text, int open) {
  var level = 0;
  final stop = math.min(text.length, open + _scanCap);
  for (var i = open; i < stop; i++) {
    if (text[i] == r'\') {
      i++;
      continue;
    }
    if (text[i] == '[') level++;
    if (text[i] == ']') {
      level--;
      if (level == 0) return i;
    }
  }
  return -1;
}

const _emphasis = [
  ('**', MdSpanKind.strong),
  ('__', MdSpanKind.strong),
  ('~~', MdSpanKind.del),
  ('*', MdSpanKind.em),
  ('_', MdSpanKind.em),
];

({MdInline node, int next})? _readEmphasis(String text, int i, int depth) {
  for (final (marker, kind) in _emphasis) {
    if (!text.startsWith(marker, i)) continue;
    final firstAt = i + marker.length;
    if (firstAt >= text.length) continue;
    final first = text[firstAt];
    if (first == ' ' || first == '\n') continue;
    // Underscores inside words are literal (snake_case).
    if (marker[0] == '_' && _isWordAt(text, i - 1)) continue;
    final end = _findClosing(text, firstAt, marker);
    if (end < 0) continue;
    if (marker[0] == '_' && _isWordAt(text, end + marker.length)) continue;
    return (
      node: MdSpan(
        kind,
        parseMdInline(text.substring(firstAt, end), depth + 1),
      ),
      next: end + marker.length,
    );
  }
  return null;
}

/// The inline nodes of [text].
List<MdInline> parseMdInline(String text, [int depth = 0]) {
  final out = <MdInline>[];
  final buffer = StringBuffer();
  void flush() {
    if (buffer.isNotEmpty) {
      out.add(MdText(buffer.toString()));
      buffer.clear();
    }
  }

  var i = 0;
  while (i < text.length) {
    final char = text[i];
    if (char == r'\' &&
        i + 1 < text.length &&
        _escapable.hasMatch(text[i + 1])) {
      buffer.write(text[i + 1]);
      i += 2;
      continue;
    }
    if (char == '\n') {
      flush();
      out.add(const MdBreak());
      i++;
      continue;
    }
    if (char == '`') {
      final end = _indexWithin(text, '`', i + 1, _scanCap);
      if (end > i + 1) {
        flush();
        out.add(MdCode(text.substring(i + 1, end)));
        i = end + 1;
        continue;
      }
    }
    if (depth < _maxNesting && (char == '*' || char == '_' || char == '~')) {
      final emphasis = _readEmphasis(text, i, depth);
      if (emphasis != null) {
        flush();
        out.add(emphasis.node);
        i = emphasis.next;
        continue;
      }
    }
    if (char == '[' && depth < _maxNesting) {
      final close = _findBracket(text, i);
      if (close > i && close + 1 < text.length && text[close + 1] == '(') {
        final end = _indexWithin(text, ')', close + 2, _targetCap);
        if (end > close + 1) {
          final target = text
              .substring(close + 2, end)
              .trim()
              .split(_spaces)
              .first;
          final href = openableUrl(target.replaceAll(RegExp(r'^<|>$'), ''));
          final label = parseMdInline(text.substring(i + 1, close), depth + 1);
          flush();
          if (href != null) {
            out.add(MdLink(href, label));
          } else {
            out.addAll(label);
          }
          i = end + 1;
          continue;
        }
      }
    }
    buffer.write(char);
    i++;
  }
  flush();
  return out;
}

final _listItem = RegExp(r'^(\s{0,3})([-*+]|\d{1,9}[.)])\s+(.*)$');
final _fence = RegExp(r'^\s{0,3}(```|~~~)\s*([\w+#.-]{0,30})\s*$');
final _headingStart = RegExp(r'^ {0,3}(#{1,6})[ \t]');

/// An ATX heading `## Title ##`: its level and text, without a regex that
/// backtracks over the line (79 S2).
({int level, String text})? _headingOf(String line) {
  final start = _headingStart.firstMatch(line);
  if (start == null) return null;
  var text = line.substring(start.end).trimRight();
  var end = text.length;
  while (end > 0 && text[end - 1] == '#') {
    end--;
  }
  // A closing run of # counts only after a space (or as the whole text).
  if (end == 0 || text[end - 1] == ' ' || text[end - 1] == '\t') {
    text = text.substring(0, end);
  }
  return (level: start[1]!.length, text: text.trim());
}

final _rule = RegExp(r'^\s{0,3}([-*_])(\s*\1){2,}\s*$');
final _quoteLine = RegExp(r'^\s{0,3}>');
final _quotePrefix = RegExp(r'^\s{0,3}>\s?');
final _digit = RegExp(r'\d');
final _indent = RegExp(r'^\s{2,}');
final _indentPrefix = RegExp(r'^\s{2,4}');

/// The blocks of [input].
List<MdBlock> parseMarkdown(String input, [int depth = 0]) {
  final clipped = input.length > mdParseBudget
      ? input.substring(0, mdParseBudget)
      : input;
  final lines = clipped.replaceAll(RegExp(r'\r\n?'), '\n').split('\n');
  final blocks = <MdBlock>[];
  var paragraph = <String>[];
  void flushParagraph() {
    if (paragraph.isNotEmpty) {
      blocks.add(MdParagraph(parseMdInline(paragraph.join('\n'))));
      paragraph = [];
    }
  }

  var i = 0;
  while (i < lines.length) {
    final line = lines[i];
    final fence = _fence.firstMatch(line);
    if (fence != null) {
      flushParagraph();
      final body = <String>[];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1]!)) {
        body.add(lines[i]);
        i++;
      }
      i++;
      final language = fence[2];
      blocks.add(
        MdCodeBlock(
          body.join('\n'),
          language: language == null || language.isEmpty ? null : language,
        ),
      );
      continue;
    }
    if (line.trim().isEmpty) {
      flushParagraph();
      i++;
      continue;
    }
    final heading = _headingOf(line);
    if (heading != null) {
      flushParagraph();
      final level = heading.level.clamp(1, 3);
      blocks.add(MdHeading(level, parseMdInline(heading.text)));
      i++;
      continue;
    }
    if (_rule.hasMatch(line)) {
      flushParagraph();
      blocks.add(const MdRule());
      i++;
      continue;
    }
    if (_quoteLine.hasMatch(line) && depth < _maxNesting) {
      flushParagraph();
      final quoted = <String>[];
      while (i < lines.length && _quoteLine.hasMatch(lines[i])) {
        quoted.add(lines[i].replaceFirst(_quotePrefix, ''));
        i++;
      }
      blocks.add(MdQuote(parseMarkdown(quoted.join('\n'), depth + 1)));
      continue;
    }
    final item = _listItem.firstMatch(line);
    if (item != null &&
        depth < _maxNesting &&
        (paragraph.isEmpty || item[2] == '-' || item[2] == '*')) {
      flushParagraph();
      final ordered = _digit.hasMatch(item[2]!);
      final start = ordered
          ? int.tryParse(item[2]!.substring(0, item[2]!.length - 1)) ?? 1
          : 1;
      final items = <List<String>>[];
      while (i < lines.length) {
        final current = _listItem.firstMatch(lines[i]);
        if (current != null &&
            current[1]!.length <= 1 &&
            _digit.hasMatch(current[2]!) == ordered) {
          items.add([current[3]!]);
          i++;
          continue;
        }
        if (items.isNotEmpty &&
            lines[i].trim().isNotEmpty &&
            _indent.hasMatch(lines[i])) {
          items.last.add(lines[i].replaceFirst(_indentPrefix, ''));
          i++;
          continue;
        }
        break;
      }
      blocks.add(
        MdList(
          ordered: ordered,
          start: start,
          items: [
            for (final body in items) parseMarkdown(body.join('\n'), depth + 1),
          ],
        ),
      );
      continue;
    }
    paragraph.add(line);
    i++;
  }
  flushParagraph();
  return blocks;
}

/// The plain text of inline nodes (for labels and summaries).
String mdInlineText(List<MdInline> nodes) => nodes
    .map(
      (node) => switch (node) {
        MdText(:final text) || MdCode(:final text) => text,
        MdBreak() => '\n',
        MdSpan(:final children) ||
        MdLink(:final children) => mdInlineText(children),
      },
    )
    .join();
