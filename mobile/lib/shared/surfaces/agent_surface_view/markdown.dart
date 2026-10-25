part of '../agent_surface_view.dart';

/// The safe Markdown subset drawn with the app's own widgets from the parse
/// tree: never agent HTML. Links are only what [openableUrl] allowed and
/// open through the host, outside hosts confirmed first.
class _MarkdownText extends HookWidget {
  final String text;
  const _MarkdownText({required this.text});

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    // Past the surface's parse budget the text shows as written (79 S2).
    final plain = useMemoized(
      () => <MdBlock>[
        MdParagraph([MdText(text)]),
      ],
      [text],
    );
    final blocks = scope.markdownOf(text) ?? plain;
    final open = useRef<void Function(String url)>((_) {});
    open.value = (url) => scope.openLink(context, url);
    // One recognizer per link, made once per text and released with it.
    final recognizers = useMemoized(
      () => [
        for (final href in _linksOf(blocks))
          TapGestureRecognizer()..onTap = () => open.value(href),
      ],
      [blocks],
    );
    useEffect(
      () => () {
        for (final recognizer in recognizers) {
          recognizer.dispose();
        }
      },
      [recognizers],
    );
    var next = 0;
    TapGestureRecognizer? link(String _) =>
        next < recognizers.length ? recognizers[next++] : null;
    return _Gapped(
      children: [for (final block in blocks) _block(context, block, link)],
    );
  }

  static Iterable<String> _linksOf(List<MdBlock> blocks) sync* {
    Iterable<String> inline(List<MdInline> nodes) sync* {
      for (final node in nodes) {
        switch (node) {
          case MdLink(:final href):
            yield href;
          case MdSpan(:final children):
            yield* inline(children);
          case MdText() || MdCode() || MdBreak():
            break;
        }
      }
    }

    for (final block in blocks) {
      switch (block) {
        case MdParagraph(:final children) || MdHeading(:final children):
          yield* inline(children);
        case MdList(:final items):
          for (final item in items) {
            yield* _linksOf(item);
          }
        case MdQuote(:final children):
          yield* _linksOf(children);
        case MdCodeBlock() || MdRule():
          break;
      }
    }
  }

  Widget _block(
    BuildContext context,
    MdBlock block,
    TapGestureRecognizer? Function(String url) link,
  ) {
    final base = _body(context);
    final colors = context.colors;
    switch (block) {
      case MdParagraph(:final children):
        return Text.rich(
          TextSpan(style: base, children: _inline(context, children, link)),
        );
      case MdHeading(:final level, :final children):
        return Semantics(
          header: true,
          child: Text.rich(
            TextSpan(
              style: switch (level) {
                1 => context.textTheme.titleSmall?.copyWith(
                  fontWeight: FontWeight.w600,
                ),
                2 => base.copyWith(fontWeight: FontWeight.w600),
                _ => base.copyWith(fontWeight: FontWeight.w500),
              },
              children: _inline(context, children, link),
            ),
          ),
        );
      case MdList(:final ordered, :final start, :final items):
        return _Gapped(
          gap: Grid.half,
          children: [
            for (final (index, item) in items.indexed)
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: Grid.sm - Grid.half,
                    child: Text(
                      ordered ? '${start + index}.' : '•',
                      style: base,
                    ),
                  ),
                  Expanded(
                    child: _Gapped(
                      gap: Grid.half,
                      children: [
                        for (final child in item) _block(context, child, link),
                      ],
                    ),
                  ),
                ],
              ),
          ],
        );
      case MdQuote(:final children):
        return Container(
          padding: const EdgeInsetsDirectional.only(start: Grid.twelve),
          decoration: BoxDecoration(
            border: BorderDirectional(
              start: BorderSide(color: colors.outlineVariant, width: 2),
            ),
          ),
          child: DefaultTextStyle.merge(
            style: TextStyle(color: colors.onSurfaceVariant),
            child: _Gapped(
              children: [
                for (final child in children) _block(context, child, link),
              ],
            ),
          ),
        );
      case MdCodeBlock(:final text):
        return Container(
          padding: const EdgeInsets.symmetric(
            horizontal: Grid.twelve,
            vertical: Grid.xxs,
          ),
          decoration: BoxDecoration(
            color: colors.surfaceContainerHighest,
            borderRadius: BorderRadius.circular(Radii.md),
          ),
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Text(
              text,
              style: bodyExtraSmallTextStyle.copyWith(fontFamily: 'monospace'),
            ),
          ),
        );
      case MdRule():
        return Divider(height: 1, color: colors.outlineVariant);
    }
  }

  List<InlineSpan> _inline(
    BuildContext context,
    List<MdInline> nodes,
    TapGestureRecognizer? Function(String url) link,
  ) => [
    for (final node in nodes)
      switch (node) {
        MdText(:final text) => TextSpan(text: text),
        MdBreak() => const TextSpan(text: '\n'),
        MdSpan(:final kind, :final children) => TextSpan(
          style: switch (kind) {
            MdSpanKind.strong => const TextStyle(fontWeight: FontWeight.w600),
            MdSpanKind.em => const TextStyle(fontStyle: FontStyle.italic),
            MdSpanKind.del => const TextStyle(
              decoration: TextDecoration.lineThrough,
            ),
          },
          children: _inline(context, children, link),
        ),
        MdCode(:final text) => TextSpan(
          text: text,
          style: TextStyle(
            fontFamily: 'monospace',
            backgroundColor: context.colors.surfaceContainerHighest,
          ),
        ),
        // A link is one span: a recognizer only hears its own text.
        MdLink(:final href, :final children) => TextSpan(
          text: mdInlineText(children),
          style: TextStyle(
            color: context.colors.primary,
            decoration: TextDecoration.underline,
          ),
          recognizer: link(href),
        ),
      },
  ];
}
