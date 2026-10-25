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

/// A part this app can't draw (a newer catalog type). Never its raw props.
class _NewerAppRow extends StatelessWidget {
  const _NewerAppRow();

  @override
  Widget build(BuildContext context) {
    final muted = context.colors.onSurfaceVariant;
    return Row(
      children: [
        Icon(BuzzIcons.sparkles, size: 14, color: muted),
        const SizedBox(width: Grid.half + Grid.quarter),
        Expanded(
          child: Text(
            'Part of this needs a newer version of the app.',
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
    return _viewFor((component: component, scope: scope, depth: depth)) ??
        const _NewerAppRow();
  }
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
