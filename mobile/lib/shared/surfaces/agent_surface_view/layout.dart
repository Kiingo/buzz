part of '../agent_surface_view.dart';

// §4.1 Layout. Selections here (tabs, open sections, steps) are kept on
// screen only: this app shows surfaces view only.

class _StackView extends StatelessWidget {
  final _NodeProps p;
  const _StackView(this.p);

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    final children = _childrenOf(scope.children(p.component, p.scope), p.depth);
    final gap = _gapOf(scope.string(p.component, 'gap'));
    final align = scope.string(p.component, 'align');
    if (scope.string(p.component, 'direction') == 'horizontal') {
      // A row that doesn't fit wraps, as the other apps fall back to a column.
      final justify = scope.string(p.component, 'justify');
      return Wrap(
        spacing: gap,
        runSpacing: gap,
        alignment: switch (justify) {
          'center' => WrapAlignment.center,
          'end' => WrapAlignment.end,
          'spaceBetween' => WrapAlignment.spaceBetween,
          _ => WrapAlignment.start,
        },
        crossAxisAlignment: switch (align) {
          'start' => WrapCrossAlignment.start,
          'end' => WrapCrossAlignment.end,
          _ => WrapCrossAlignment.center,
        },
        children: children,
      );
    }
    return _Gapped(
      gap: gap,
      align: switch (align) {
        'center' => CrossAxisAlignment.center,
        'end' => CrossAxisAlignment.end,
        'start' => CrossAxisAlignment.start,
        _ => CrossAxisAlignment.stretch,
      },
      children: children,
    );
  }
}

/// Columns that collapse to one when the card is narrow.
class _GridView extends StatelessWidget {
  final _NodeProps p;
  const _GridView(this.p);

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    final wanted = (scope.number(p.component, 'columns', p.scope) ?? 2)
        .round()
        .clamp(1, 4);
    final gap = _gapOf(scope.string(p.component, 'gap'));
    final children = _childrenOf(scope.children(p.component, p.scope), p.depth);
    return LayoutBuilder(
      builder: (context, constraints) {
        final width = constraints.maxWidth;
        final columns = width < 448
            ? 1
            : width < 672
            ? math.min(wanted, 2)
            : wanted;
        if (columns == 1) return _Gapped(gap: gap, children: children);
        final cell = (width - gap * (columns - 1)) / columns;
        return Wrap(
          spacing: gap,
          runSpacing: gap,
          children: [
            for (final child in children) SizedBox(width: cell, child: child),
          ],
        );
      },
    );
  }
}

class _Heading extends StatelessWidget {
  final String? title;
  final String? subtitle;
  const _Heading({this.title, this.subtitle});

  @override
  Widget build(BuildContext context) {
    final heading = title;
    final detail = subtitle;
    if (heading == null && detail == null) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (heading != null)
          Semantics(
            header: true,
            child: Text(
              heading,
              style: _body(context, weight: FontWeight.w600),
            ),
          ),
        if (detail != null) Text(detail, style: _small(context)),
      ],
    );
  }
}

class _SectionView extends HookWidget {
  final _NodeProps p;
  const _SectionView(this.p);

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    final title = scope.text(p.component, 'title', p.scope, max: 200);
    final subtitle = scope.text(p.component, 'subtitle', p.scope, max: 300);
    final collapsible = scope.flag(p.component, 'collapsible', p.scope);
    final open = useState(!scope.flag(p.component, 'collapsed', p.scope));
    final children = _childrenOf(scope.children(p.component, p.scope), p.depth);
    if (!collapsible) {
      return _Gapped(
        children: [
          _Heading(title: title, subtitle: subtitle),
          ...children,
        ],
      );
    }
    return _Gapped(
      children: [
        Semantics(
          button: true,
          expanded: open.value,
          child: InkWell(
            onTap: () => open.value = !open.value,
            borderRadius: BorderRadius.circular(Radii.sm),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                AnimatedRotation(
                  turns: open.value ? 0.25 : 0,
                  duration: const Duration(milliseconds: 150),
                  child: Icon(
                    BuzzIcons.chevronRight,
                    size: 16,
                    color: context.colors.onSurfaceVariant,
                  ),
                ),
                const SizedBox(width: Grid.half + Grid.quarter),
                Expanded(
                  child: _Heading(
                    title: title ?? 'Section',
                    subtitle: subtitle,
                  ),
                ),
              ],
            ),
          ),
        ),
        if (open.value)
          Padding(
            padding: const EdgeInsetsDirectional.only(
              start: Grid.sm - Grid.half,
            ),
            child: _Gapped(children: children),
          ),
      ],
    );
  }
}

class _CardView extends StatelessWidget {
  final _NodeProps p;
  const _CardView(this.p);

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    final media = asObject(p.component.props['media']);
    final action = scope.action(p.component.props['onTap']);
    // A Card tap never sends a message (79 M1): its words aren't shown.
    final tappable = action != null && scope.canTap(action, sends: false);
    final body = _Gapped(
      children: [
        if (media != null)
          ConstrainedBox(
            constraints: const BoxConstraints(maxHeight: 176),
            child: _ProxyImage(
              url: scope.textOf(media['url'], p.scope, max: 2048),
              alt: scope.textOf(media['alt'], p.scope, max: 300) ?? '',
              cover: true,
              aspect: 16 / 9,
            ),
          ),
        _Heading(
          title: scope.text(p.component, 'title', p.scope, max: 200),
          subtitle: scope.text(p.component, 'subtitle', p.scope, max: 300),
        ),
        ..._childrenOf(scope.children(p.component, p.scope, 'child'), p.depth),
      ],
    );
    if (!tappable) return _Panel(child: body);
    return Semantics(
      button: true,
      hint: action.label,
      child: Material(
        type: MaterialType.transparency,
        child: InkWell(
          borderRadius: BorderRadius.circular(Radii.lg),
          onTap: () => scope.perform(context, action, sends: false),
          child: _Panel(child: body),
        ),
      ),
    );
  }
}

typedef _TabPanel = ({int index, String title, List<SurfaceChildRef> children});

List<_TabPanel> _panelsOf(_SurfaceContext scope, _NodeProps p) => [
  for (final (index, item)
      in scope.list(p.component, 'items', p.scope).take(20).indexed)
    (
      index: index,
      title:
          scope.textOf(fieldOf(item, 'title'), p.scope, max: 80) ??
          'Tab ${index + 1}',
      children: childrenOf(fieldOf(item, 'child'), scope.data, p.scope),
    ),
];

/// The bound index (the starting selection here), else 0.
int _boundIndex(_SurfaceContext scope, Object? prop, Pointer at, int count) {
  final path = asString(fieldOf(prop, 'path'));
  final pointer = path == null ? null : resolvePointer(path, at);
  final value = pointer == null ? null : asInt(readAt(scope.data, pointer));
  return (value ?? 0).clamp(0, math.max(0, count - 1));
}

class _TabsView extends HookWidget {
  final _NodeProps p;
  const _TabsView(this.p);

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    final panels = _panelsOf(scope, p);
    final selected = useState(
      _boundIndex(scope, p.component.props['selected'], p.scope, panels.length),
    );
    if (panels.isEmpty) return const SizedBox.shrink();
    final current = panels[selected.value.clamp(0, panels.length - 1)];
    return _Gapped(
      gap: Grid.twelve,
      children: [
        Wrap(
          spacing: Grid.half,
          runSpacing: Grid.half,
          children: [
            for (final panel in panels)
              ChoiceChip(
                label: Text(panel.title),
                selected: panel.index == current.index,
                showCheckmark: false,
                onSelected: (_) => selected.value = panel.index,
              ),
          ],
        ),
        _Gapped(children: _childrenOf(current.children, p.depth)),
      ],
    );
  }
}

class _AccordionView extends HookWidget {
  final _NodeProps p;
  const _AccordionView(this.p);

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    final panels = _panelsOf(scope, p);
    final multiple = scope.string(p.component, 'mode') == 'multiple';
    final open = useState(<int>{});
    final border = context.colors.outlineVariant;
    return Container(
      decoration: BoxDecoration(
        border: Border.all(color: border),
        borderRadius: BorderRadius.circular(Radii.md),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final panel in panels) ...[
            if (panel.index > 0) Divider(height: 1, color: border),
            Semantics(
              button: true,
              expanded: open.value.contains(panel.index),
              child: InkWell(
                onTap: () {
                  final isOpen = open.value.contains(panel.index);
                  open.value = isOpen
                      ? ({...open.value}..remove(panel.index))
                      : multiple
                      ? {...open.value, panel.index}
                      : {panel.index};
                },
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: Grid.twelve,
                    vertical: Grid.xxs,
                  ),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          panel.title,
                          style: _body(context, weight: FontWeight.w500),
                        ),
                      ),
                      AnimatedRotation(
                        turns: open.value.contains(panel.index) ? 0.5 : 0,
                        duration: const Duration(milliseconds: 150),
                        child: Icon(
                          BuzzIcons.chevronDown,
                          size: 16,
                          color: context.colors.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
            if (open.value.contains(panel.index))
              Padding(
                padding: const EdgeInsets.fromLTRB(
                  Grid.twelve,
                  0,
                  Grid.twelve,
                  Grid.twelve,
                ),
                child: _Gapped(children: _childrenOf(panel.children, p.depth)),
              ),
          ],
        ],
      ),
    );
  }
}

class _CarouselView extends StatelessWidget {
  final _NodeProps p;
  const _CarouselView(this.p);

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    final width = scope.string(p.component, 'itemWidth') == 'compact'
        ? 208.0
        : 288.0;
    final children = _childrenOf(scope.children(p.component, p.scope), p.depth);
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: _spaced(
          [for (final child in children) SizedBox(width: width, child: child)],
          Grid.twelve,
          row: true,
        ),
      ),
    );
  }
}

/// Steps walked on screen. View only: Next doesn't check the fields (they
/// can't be filled here).
class _StepsView extends HookWidget {
  final _NodeProps p;
  const _StepsView(this.p);

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    final steps = scope.list(p.component, 'steps', p.scope).take(20).toList();
    final index = useState(
      _boundIndex(scope, p.component.props['current'], p.scope, steps.length),
    );
    if (steps.isEmpty) return const SizedBox.shrink();
    final at = index.value.clamp(0, steps.length - 1);
    final step = steps[at];
    final title = scope.textOf(fieldOf(step, 'title'), p.scope, max: 120);
    final finish = scope.action(p.component.props['finishAction']);
    return _Gapped(
      gap: Grid.twelve,
      children: [
        Semantics(
          liveRegion: true,
          child: Text(
            'Step ${at + 1} of ${steps.length}',
            style: _small(context),
          ),
        ),
        if (title != null)
          Semantics(
            header: true,
            child: Text(title, style: _body(context, weight: FontWeight.w600)),
          ),
        ..._childrenOf(
          childrenOf(fieldOf(step, 'child'), scope.data, p.scope),
          p.depth,
        ),
        if (at > 0 || at < steps.length - 1)
          Row(
            children: [
              if (at > 0)
                _SurfaceButton(
                  label: 'Back',
                  onPressed: () => index.value = at - 1,
                ),
              const Spacer(),
              if (at < steps.length - 1)
                _SurfaceButton(
                  label: 'Next',
                  style: SurfaceActionStyle.primary,
                  onPressed: () => index.value = at + 1,
                ),
            ],
          ),
        // The finish action on its own full-width row: its label and the
        // words it sends wrap there instead of overflowing beside Back
        // (79).
        if (at == steps.length - 1 && finish != null)
          _ActionButton(action: finish, scope: p.scope, fullWidth: true),
      ],
    );
  }
}

class _DividerView extends StatelessWidget {
  final _NodeProps p;
  const _DividerView(this.p);

  @override
  Widget build(BuildContext context) {
    final label = _SurfaceScope.of(
      context,
    ).text(p.component, 'label', p.scope, max: 80);
    final line = context.colors.outlineVariant;
    if (label == null) return Divider(height: 1, color: line);
    return Row(
      children: [
        Expanded(child: Divider(height: 1, color: line)),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: Grid.xxs),
          child: Text(label, style: _small(context)),
        ),
        Expanded(child: Divider(height: 1, color: line)),
      ],
    );
  }
}

/// A sheet opened by a tap on its entry (or a Show button). A bound `open`
/// never opens it by itself: a card in the chat doesn't pop up while
/// scrolling.
class _ModalView extends HookWidget {
  final _NodeProps p;
  const _ModalView(this.p);

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    final title = scope.text(p.component, 'title', p.scope, max: 120);
    final entry = scope.children(p.component, p.scope, 'entry');
    final down = useRef<Offset?>(null);
    void show() {
      final content = _childrenOf(
        scope.children(p.component, p.scope, 'content'),
        p.depth,
      );
      unawaited(
        showBuzzModalBottomSheet<void>(
          context: context,
          title: title ?? 'Details',
          isScrollControlled: true,
          builder: (sheetContext) => _SurfaceScope(
            data: scope,
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(Grid.xs),
              child: _Gapped(children: content),
            ),
          ),
        ),
      );
    }

    if (entry.isEmpty) {
      return Align(
        alignment: AlignmentDirectional.centerStart,
        child: _SurfaceButton(
          label: scope.text(p.component, 'title', p.scope, max: 60) ?? 'Show',
          onPressed: show,
        ),
      );
    }
    // The entry (a Link or Button) keeps its own action; a tap on it also
    // opens the sheet. A drag doesn't.
    return Listener(
      onPointerDown: (event) => down.value = event.position,
      onPointerUp: (event) {
        final start = down.value;
        down.value = null;
        if (start != null && (event.position - start).distance < 12) show();
      },
      child: _Gapped(children: _childrenOf(entry, p.depth)),
    );
  }
}
