/// Word- or line-level diff for the Diff component: an LCS over tokens,
/// capped so a huge input degrades to a whole replace instead of hanging.
library;

import 'dart:math' as math;
import 'dart:typed_data';

/// How a diff part changed.
enum SurfaceDiffKind { same, added, removed }

/// One run of text in a diff.
typedef SurfaceDiffPart = ({SurfaceDiffKind kind, String text});

/// Most LCS cells for one diff: fewer than the web renderers allow, as a
/// phone's memory is tighter.
const surfaceDiffMaxCells = 1000000;

/// Most LCS cells for all of one surface's diffs (79 S4); past it a diff
/// is a whole replace.
const surfaceDiffSurfaceCells = 4000000;

final _wordTokens = RegExp(
  r"\s+|[\p{L}\p{N}_'’-]+|[^\s\p{L}\p{N}_]",
  unicode: true,
);
final _lineEnds = RegExp(r'(?<=\n)');

/// [text] as diff tokens.
List<String> surfaceDiffTokens(String text, {bool lines = false}) => lines
    ? text.split(_lineEnds)
    : [for (final match in _wordTokens.allMatches(text)) match[0]!];

/// The parts that turn [before] into [after].
List<SurfaceDiffPart> surfaceDiff(
  String before,
  String after, {
  bool lines = false,
  int maxCells = surfaceDiffMaxCells,
  void Function(int cells)? spent,
}) {
  final a = surfaceDiffTokens(before, lines: lines);
  final b = surfaceDiffTokens(after, lines: lines);
  // Trim the common head and tail first: most edits are local.
  var start = 0;
  while (start < a.length && start < b.length && a[start] == b[start]) {
    start++;
  }
  var endA = a.length;
  var endB = b.length;
  while (endA > start && endB > start && a[endA - 1] == b[endB - 1]) {
    endA--;
    endB--;
  }
  final parts = <SurfaceDiffPart>[];
  void push(SurfaceDiffKind kind, String text) {
    if (text.isEmpty) return;
    if (parts.isNotEmpty && parts.last.kind == kind) {
      parts[parts.length - 1] = (kind: kind, text: parts.last.text + text);
    } else {
      parts.add((kind: kind, text: text));
    }
  }

  push(SurfaceDiffKind.same, a.sublist(0, start).join());
  final midA = a.sublist(start, endA);
  final midB = b.sublist(start, endB);
  final n = midA.length;
  final m = midB.length;
  if (n * m > maxCells) {
    push(SurfaceDiffKind.removed, midA.join());
    push(SurfaceDiffKind.added, midB.join());
  } else {
    spent?.call(n * m);
    final table = List.generate(n + 1, (_) => Uint32List(m + 1));
    for (var i = n - 1; i >= 0; i--) {
      for (var j = m - 1; j >= 0; j--) {
        table[i][j] = midA[i] == midB[j]
            ? table[i + 1][j + 1] + 1
            : math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
    var i = 0;
    var j = 0;
    while (i < n && j < m) {
      if (midA[i] == midB[j]) {
        push(SurfaceDiffKind.same, midA[i]);
        i++;
        j++;
      } else if (table[i + 1][j] >= table[i][j + 1]) {
        push(SurfaceDiffKind.removed, midA[i]);
        i++;
      } else {
        push(SurfaceDiffKind.added, midB[j]);
        j++;
      }
    }
    while (i < n) {
      push(SurfaceDiffKind.removed, midA[i++]);
    }
    while (j < m) {
      push(SurfaceDiffKind.added, midB[j++]);
    }
  }
  push(SurfaceDiffKind.same, a.sublist(endA).join());
  return parts;
}

/// One surface's diffs, each worked out once, sharing
/// [surfaceDiffSurfaceCells].
class SurfaceDiffMemo {
  var _left = surfaceDiffSurfaceCells;
  final _parts = <(String, String, bool), List<SurfaceDiffPart>>{};

  /// [surfaceDiff] of [before] and [after], from the memo when seen.
  List<SurfaceDiffPart> diff(
    String before,
    String after, {
    bool lines = false,
  }) => _parts[(before, after, lines)] ??= surfaceDiff(
    before,
    after,
    lines: lines,
    maxCells: math.min(surfaceDiffMaxCells, _left),
    spent: (cells) => _left -= cells,
  );
}
