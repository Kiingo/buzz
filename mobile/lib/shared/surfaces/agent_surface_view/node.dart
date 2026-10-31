part of '../agent_surface_view.dart';

/// One view per catalog type. Every type in [surfaceComponentTypes] has one.
Widget? _viewFor(_NodeProps p) => switch (p.component.type) {
  'Stack' => _StackView(p),
  'Grid' => _GridView(p),
  'Section' => _SectionView(p),
  'Card' => _CardView(p),
  'Tabs' => _TabsView(p),
  'Accordion' => _AccordionView(p),
  'Carousel' => _CarouselView(p),
  'Steps' => _StepsView(p),
  'Divider' => _DividerView(p),
  'Modal' => _ModalView(p),
  'Text' => _TextView(p),
  'Markdown' => _MarkdownView(p),
  'Image' => _ImageView(p),
  'ImageGallery' => _ImageGalleryView(p),
  'Icon' => _IconView(p),
  'Badge' => _BadgeView(p),
  'Avatar' => _AvatarView(p),
  'KeyValue' => _KeyValueView(p),
  'Table' => _TableView(p),
  'List' => _ListView(p),
  'Chart' => _ChartView(p),
  'Metric' => _MetricView(p),
  'Progress' => _ProgressView(p),
  'Timeline' => _TimelineView(p),
  'Code' => _CodeView(p),
  'Diff' => _DiffView(p),
  'Callout' => _CalloutView(p),
  'Quote' => _QuoteView(p),
  'EntityRef' => _EntityRefView(p),
  'FileList' => _FileListView(p),
  'Media' => _MediaView(p),
  'LinkPreview' => _LinkPreviewView(p),
  'Map' => _MapView(p),
  'Countdown' => _CountdownView(p),
  'Button' => _ButtonView(p),
  'ActionBar' => _ActionBarView(p),
  'SuggestionChips' => _SuggestionChipsView(p),
  'Menu' => _MenuView(p),
  'Link' => _LinkView(p),
  final type when surfaceInputTypes.contains(type) => _InputView(p),
  _ => null,
};

/// Action components a sent email card never draws.
const _sentHiddenTypes = {'Button', 'ActionBar', 'SuggestionChips', 'Menu'};

/// A part this app can't draw (a newer catalog type). Never its raw props.
class _NewerAppRow extends StatelessWidget {
  /// Another notice in the same style, else "needs a newer version".
  final String? text;

  const _NewerAppRow({this.text});

  @override
  Widget build(BuildContext context) {
    final muted = context.colors.onSurfaceVariant;
    return Row(
      children: [
        Icon(BuzzIcons.sparkles, size: 14, color: muted),
        const SizedBox(width: Grid.half + Grid.quarter),
        Expanded(
          child: Text(
            text ?? 'Part of this needs a newer version of the app.',
            style: bodyExtraSmallTextStyle.copyWith(color: muted),
          ),
        ),
      ],
    );
  }
}

/// One component by id at one scope; hidden by `visibleWhen`, cut off past
/// depth 12.
class _Node extends StatelessWidget {
  final String componentId;
  final Pointer scope;
  final int depth;

  const _Node({
    super.key,
    required this.componentId,
    required this.scope,
    required this.depth,
  });

  @override
  Widget build(BuildContext context) {
    if (depth > surfaceMaxDepth) return const SizedBox.shrink();
    final surface = _SurfaceScope.of(context).surface;
    final component = surface.components[componentId];
    if (component == null ||
        !isVisible(component.visibleWhen, surface.data, scope)) {
      return const SizedBox.shrink();
    }
    if (!component.known) return const _NewerAppRow();
    // A sent email card is a read-only record of what went out (Ross,
    // 2026-10-31): no Send, Revise or Discard, no chips or menus.
    if (_sentHiddenTypes.contains(component.type) &&
        sentEmailOf(surface) != null) {
      return const SizedBox.shrink();
    }
    final props = (component: component, scope: scope, depth: depth);
    final view = _viewFor(props) ?? const _NewerAppRow();
    return readsUntrusted(surface, component, scope)
        ? _quoteUntrusted(_SurfaceScope.of(context), props, view)
        : view;
  }
}

/// The one way outside content is drawn (§10, 79 S5): text as a plain
/// quote, anything else inside a quote frame with no links or actions
/// (taps and screen-reader actions are blocked).
Widget _quoteUntrusted(_SurfaceContext scope, _NodeProps p, Widget view) {
  if (const {'Text', 'Markdown', 'Quote'}.contains(p.component.type)) {
    final text = scope.text(p.component, 'text', p.scope, max: 20000);
    return text == null ? const SizedBox.shrink() : _QuoteBox(text: text);
  }
  return _QuoteBox(child: IgnorePointer(child: view));
}

/// A container's children, one level deeper, as widgets.
List<Widget> _childrenOf(List<SurfaceChildRef> refs, int depth) => [
  for (final ref in refs)
    _Node(
      key: ValueKey(ref.key),
      componentId: ref.componentId,
      scope: ref.scope,
      depth: depth + 1,
    ),
];

/// [children] with [gap] between them.
List<Widget> _spaced(List<Widget> children, double gap, {bool row = false}) => [
  for (var i = 0; i < children.length; i++) ...[
    if (i > 0) SizedBox(width: row ? gap : 0, height: row ? 0 : gap),
    children[i],
  ],
];

/// A vertical list of [children] with [gap] between them.
class _Gapped extends StatelessWidget {
  final List<Widget> children;
  final double gap;
  final CrossAxisAlignment align;

  const _Gapped({
    required this.children,
    this.gap = Grid.xxs,
    this.align = CrossAxisAlignment.stretch,
  });

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: align,
    mainAxisSize: MainAxisSize.min,
    children: _spaced(children, gap),
  );
}
