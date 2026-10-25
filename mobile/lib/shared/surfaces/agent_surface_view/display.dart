part of '../agent_surface_view.dart';

// §4.2 Display. Agent text is plain text (Text widgets, never markup);
// outside content is a Quote with no links.

class _TextView extends StatelessWidget {
  final _NodeProps p;
  const _TextView(this.p);

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    final text = scope.text(p.component, 'text', p.scope);
    if (text == null) return const SizedBox.shrink();
    if (scope.isUntrusted(p.component, 'text', p.scope)) {
      return _QuoteBox(text: text);
    }
    final variant = scope.string(p.component, 'variant') ?? 'body';
    final tone =
        scope.string(p.component, 'tone') ??
        (variant == 'caption' ? 'muted' : null);
    final color = _toneColor(context, tone);
    final theme = context.textTheme;
    final style = switch (variant) {
      'h1' => theme.titleMedium?.copyWith(fontWeight: FontWeight.w600),
      'h2' => theme.titleSmall?.copyWith(fontWeight: FontWeight.w600),
      'h3' => theme.labelLarge?.copyWith(fontWeight: FontWeight.w600),
      'caption' => bodyExtraSmallTextStyle,
      'label' => _body(context, weight: FontWeight.w500),
      _ => _body(context),
    };
    final lines = scope.number(p.component, 'maxLines', p.scope);
    final widget = Text(
      text,
      style: (style ?? const TextStyle()).copyWith(color: color),
      maxLines: lines == null ? null : math.max(1, lines.round()),
      overflow: lines == null ? null : TextOverflow.ellipsis,
    );
    return variant.startsWith('h')
        ? Semantics(header: true, child: widget)
        : widget;
  }
}

class _MarkdownView extends StatelessWidget {
  final _NodeProps p;
  const _MarkdownView(this.p);

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    final text = scope.text(p.component, 'text', p.scope, max: 20000);
    if (text == null) return const SizedBox.shrink();
    if (scope.isUntrusted(p.component, 'text', p.scope)) {
      return _QuoteBox(text: text);
    }
    return _MarkdownText(text: text);
  }
}

class _IconView extends StatelessWidget {
  final _NodeProps p;
  const _IconView(this.p);

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    final label = scope.text(p.component, 'label', p.scope, max: 80);
    final size = switch (scope.string(p.component, 'size')) {
      'sm' => 14.0,
      'lg' => 24.0,
      _ => 16.0,
    };
    final icon = Icon(
      _catalogIcon(scope.text(p.component, 'name', p.scope, max: 40)),
      size: size,
      color: _toneColor(context, scope.string(p.component, 'tone')),
      semanticLabel: label,
    );
    return Align(
      alignment: AlignmentDirectional.centerStart,
      widthFactor: 1,
      child: label == null ? ExcludeSemantics(child: icon) : icon,
    );
  }
}

class _BadgeView extends StatelessWidget {
  final _NodeProps p;
  const _BadgeView(this.p);

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    final text = scope.text(p.component, 'text', p.scope, max: 60);
    if (text == null) return const SizedBox.shrink();
    return Align(
      alignment: AlignmentDirectional.centerStart,
      widthFactor: 1,
      child: _Badge(
        text: text,
        tone: scope.string(p.component, 'tone'),
        icon: scope.string(p.component, 'icon'),
      ),
    );
  }
}

class _AvatarView extends StatelessWidget {
  final _NodeProps p;
  const _AvatarView(this.p);

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    final name = scope.text(p.component, 'name', p.scope, max: 80) ?? '';
    final initials =
        scope.text(p.component, 'initials', p.scope, max: 3) ??
        (name.isEmpty ? '?' : initialsOf(name));
    final image = scope.value(p.component, 'imageUrl', p.scope);
    final size = switch (scope.string(p.component, 'size')) {
      'sm' => 24.0,
      'lg' => 44.0,
      _ => 32.0,
    };
    final colors = context.colors;
    return Semantics(
      image: true,
      label: name.isEmpty ? 'Avatar' : name,
      excludeSemantics: true,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          ClipOval(
            child: Container(
              width: size,
              height: size,
              color: colors.surfaceContainerHighest,
              alignment: Alignment.center,
              child: image != null
                  ? _ProxyImage(url: image, alt: '', cover: true, aspect: 1)
                  : Text(
                      initials,
                      style: _small(
                        context,
                      ).copyWith(fontWeight: FontWeight.w600),
                    ),
            ),
          ),
          if (name.isNotEmpty &&
              scope.flag(p.component, 'showName', p.scope)) ...[
            const SizedBox(width: Grid.xxs),
            Flexible(child: Text(name, style: _body(context))),
          ],
        ],
      ),
    );
  }
}

class _KeyValueView extends StatelessWidget {
  final _NodeProps p;
  const _KeyValueView(this.p);

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    final items = scope.list(p.component, 'items', p.scope).take(100);
    final stacked = scope.string(p.component, 'layout') == 'stacked';
    final rows = [
      for (final item in items)
        (
          name: scope.textOf(fieldOf(item, 'name'), p.scope, max: 80) ?? '',
          value: cellText(
            resolveProp(fieldOf(item, 'value'), scope.data, p.scope),
          ),
        ),
    ];
    if (stacked) {
      return _Gapped(
        children: [
          for (final row in rows)
            MergeSemantics(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(row.name, style: _small(context)),
                  Text(row.value, style: _body(context)),
                ],
              ),
            ),
        ],
      );
    }
    return Table(
      columnWidths: const {0: IntrinsicColumnWidth(), 1: FlexColumnWidth()},
      defaultVerticalAlignment: TableCellVerticalAlignment.top,
      children: [
        for (final row in rows)
          TableRow(
            children: [
              Padding(
                padding: const EdgeInsetsDirectional.only(
                  end: Grid.twelve,
                  bottom: Grid.half + Grid.quarter,
                ),
                child: Text(
                  row.name,
                  style: _body(context, color: context.colors.onSurfaceVariant),
                ),
              ),
              Padding(
                padding: const EdgeInsets.only(
                  bottom: Grid.half + Grid.quarter,
                ),
                child: Text(row.value, style: _body(context)),
              ),
            ],
          ),
      ],
    );
  }
}

class _MetricView extends StatelessWidget {
  final _NodeProps p;
  const _MetricView(this.p);

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    final trend = scope.string(p.component, 'trend') ?? 'flat';
    final delta = scope.text(p.component, 'delta', p.scope, max: 40);
    final caption = scope.text(p.component, 'caption', p.scope, max: 200);
    final spark = [
      for (final value in scope.list(p.component, 'sparkline', p.scope))
        ?asNumber(value),
    ];
    final trendColor = switch (trend) {
      'up' => context.appColors.success,
      'down' => context.colors.error,
      _ => context.colors.onSurfaceVariant,
    };
    return _Panel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            scope.text(p.component, 'label', p.scope, max: 80) ?? '',
            style: _small(context),
          ),
          Text(
            scope.text(p.component, 'value', p.scope, max: 40) ?? '–',
            style: context.textTheme.headlineSmall?.copyWith(
              fontWeight: FontWeight.w600,
              color: _toneColor(context, scope.string(p.component, 'tone')),
            ),
          ),
          if (delta != null)
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  switch (trend) {
                    'up' => BuzzIcons.arrowUp,
                    'down' => BuzzIcons.arrowDown,
                    _ => BuzzIcons.arrowLeftRight,
                  },
                  size: 14,
                  color: trendColor,
                ),
                const SizedBox(width: Grid.half),
                Text(delta, style: _small(context, color: trendColor)),
              ],
            ),
          if (spark.length > 1)
            Padding(
              padding: const EdgeInsets.only(top: Grid.half),
              child: _Sparkline(values: spark),
            ),
          if (caption != null)
            Text(
              caption,
              style: context.textTheme.labelSmall?.copyWith(
                color: context.colors.onSurfaceVariant,
              ),
            ),
        ],
      ),
    );
  }
}

class _ProgressView extends StatelessWidget {
  final _NodeProps p;
  const _ProgressView(this.p);

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    final max = math.max(
      scope.number(p.component, 'max', p.scope) ?? 1,
      0.0001,
    );
    final value = (scope.number(p.component, 'value', p.scope) ?? 0).clamp(
      0,
      max,
    );
    final label = scope.text(p.component, 'label', p.scope, max: 120);
    final tone = scope.string(p.component, 'tone');
    final color = switch (tone) {
      'success' ||
      'warning' ||
      'danger' ||
      'muted' => _toneColor(context, tone),
      _ => context.colors.primary,
    };
    final track = context.colors.surfaceContainerHighest;
    final indeterminate = scope.flag(p.component, 'indeterminate', p.scope);
    final share = indeterminate ? null : (value / max).toDouble();
    final ring = scope.string(p.component, 'style') == 'ring';
    final bar = ring
        ? SizedBox(
            width: 40,
            height: 40,
            child: CircularProgressIndicator(
              value: share,
              strokeWidth: 4,
              color: color,
              backgroundColor: track,
            ),
          )
        : ClipRRect(
            borderRadius: BorderRadius.circular(Radii.full),
            child: LinearProgressIndicator(
              value: share,
              minHeight: 6,
              color: color,
              backgroundColor: track,
            ),
          );
    return Semantics(
      label: label ?? (indeterminate ? 'Working' : 'Progress'),
      value: share == null ? null : '${(share * 100).round()}%',
      excludeSemantics: true,
      child: ring
          ? Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                bar,
                if (label != null) ...[
                  const SizedBox(width: Grid.xxs),
                  Flexible(child: Text(label, style: _small(context))),
                ],
              ],
            )
          : _Gapped(
              gap: Grid.half,
              children: [
                if (label != null) Text(label, style: _small(context)),
                bar,
              ],
            ),
    );
  }
}

class _TimelineView extends StatelessWidget {
  final _NodeProps p;
  const _TimelineView(this.p);

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    final listed = scope.list(p.component, 'items', p.scope).take(100).toList();
    final items = scope.string(p.component, 'order') == 'newestFirst'
        ? listed.reversed.toList()
        : listed;
    final colors = context.colors;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final (index, item) in items.indexed)
          IntrinsicHeight(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                ExcludeSemantics(
                  child: Column(
                    children: [
                      Container(
                        margin: const EdgeInsets.only(top: 6),
                        width: 8,
                        height: 8,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          color: switch (asString(fieldOf(item, 'status'))) {
                            'done' => context.appColors.success,
                            'current' => colors.primary,
                            'failed' => colors.error,
                            _ => colors.onSurfaceVariant.withValues(alpha: 0.5),
                          },
                        ),
                      ),
                      if (index < items.length - 1)
                        Expanded(
                          child: Container(
                            width: 1,
                            color: colors.outlineVariant,
                          ),
                        ),
                    ],
                  ),
                ),
                const SizedBox(width: Grid.xxs + Grid.quarter),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.only(bottom: Grid.twelve),
                    child: MergeSemantics(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          if (formatSurfaceDate(fieldOf(item, 'at'))
                              case final at?)
                            Text(at, style: _small(context)),
                          Text(
                            plainText(fieldOf(item, 'title'), 200) ?? '',
                            style: _body(context, weight: FontWeight.w500),
                          ),
                          if (plainText(
                                fieldOf(item, 'body'),
                                1000,
                                lines: true,
                              )
                              case final body?)
                            Text(body, style: _small(context)),
                          if (fieldOf(item, 'status') == 'failed')
                            Text(
                              'Failed',
                              style: _small(context, color: colors.error),
                            ),
                        ],
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

class _CodeView extends HookWidget {
  final _NodeProps p;
  const _CodeView(this.p);

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    final code = scope.text(p.component, 'code', p.scope, max: 50000) ?? '';
    final language = scope.text(p.component, 'language', p.scope, max: 20);
    final wrap = scope.flag(p.component, 'wrap', p.scope);
    final copied = useState(false);
    final colors = context.colors;
    final text = Text(
      code,
      style: bodyExtraSmallTextStyle.copyWith(fontFamily: 'monospace'),
      softWrap: wrap,
    );
    return Container(
      decoration: BoxDecoration(
        color: colors.surfaceContainerHighest,
        border: Border.all(color: colors.outlineVariant),
        borderRadius: BorderRadius.circular(Radii.md),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Padding(
            padding: const EdgeInsetsDirectional.only(start: Grid.twelve),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    language ?? 'Code',
                    style: context.textTheme.labelSmall?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                ),
                TextButton(
                  onPressed: () async {
                    await Clipboard.setData(ClipboardData(text: code));
                    copied.value = true;
                  },
                  child: Text(copied.value ? 'Copied' : 'Copy'),
                ),
              ],
            ),
          ),
          Divider(height: 1, color: colors.outlineVariant),
          Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: Grid.twelve,
              vertical: Grid.xxs,
            ),
            child: wrap
                ? text
                : SingleChildScrollView(
                    scrollDirection: Axis.horizontal,
                    child: text,
                  ),
          ),
        ],
      ),
    );
  }
}

class _DiffView extends StatelessWidget {
  final _NodeProps p;
  const _DiffView(this.p);

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    final before = scope.text(p.component, 'before', p.scope, max: 20000) ?? '';
    final after = scope.text(p.component, 'after', p.scope, max: 20000) ?? '';
    if (scope.string(p.component, 'mode') == 'sideBySide') {
      return _Gapped(
        gap: Grid.twelve,
        children: [
          for (final (title, text) in [('Before', before), ('After', after)])
            MergeSemantics(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(title, style: _small(context)),
                  Text(text, style: _body(context)),
                ],
              ),
            ),
        ],
      );
    }
    final parts = surfaceDiff(
      before,
      after,
      lines: scope.string(p.component, 'granularity') == 'line',
    );
    final added = context.appColors.success;
    final removed = context.colors.error;
    final base = _body(context);
    return Semantics(
      label: parts
          .map(
            (part) => switch (part.kind) {
              SurfaceDiffKind.added => 'added ${part.text}',
              SurfaceDiffKind.removed => 'removed ${part.text}',
              SurfaceDiffKind.same => part.text,
            },
          )
          .join(),
      excludeSemantics: true,
      child: Text.rich(
        TextSpan(
          style: base,
          children: [
            for (final part in parts)
              TextSpan(
                text: part.text,
                style: switch (part.kind) {
                  SurfaceDiffKind.added => TextStyle(
                    color: added,
                    backgroundColor: added.withValues(alpha: 0.1),
                    decoration: TextDecoration.underline,
                  ),
                  SurfaceDiffKind.removed => TextStyle(
                    color: removed,
                    backgroundColor: removed.withValues(alpha: 0.1),
                    decoration: TextDecoration.lineThrough,
                  ),
                  SurfaceDiffKind.same => null,
                },
              ),
          ],
        ),
      ),
    );
  }
}

class _CalloutView extends StatelessWidget {
  final _NodeProps p;
  const _CalloutView(this.p);

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    final kind = scope.string(p.component, 'kind') ?? 'info';
    final title = scope.text(p.component, 'title', p.scope, max: 120);
    final body = scope.text(p.component, 'body', p.scope);
    return Semantics(
      liveRegion: kind == 'danger',
      child: Container(
        padding: const EdgeInsets.symmetric(
          horizontal: Grid.twelve,
          vertical: Grid.xxs + Grid.quarter,
        ),
        decoration: BoxDecoration(
          color: _toneBackground(context, kind),
          borderRadius: BorderRadius.circular(Radii.lg),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.only(top: Grid.quarter),
              child: Icon(
                _toneIcon(kind),
                size: 16,
                color: _toneOnBackground(context, kind),
              ),
            ),
            const SizedBox(width: Grid.xxs + Grid.quarter),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (title != null)
                    Text(title, style: _body(context, weight: FontWeight.w600)),
                  if (body != null)
                    Text(
                      body,
                      style: _small(context, color: context.colors.onSurface),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _QuoteView extends HookWidget {
  final _NodeProps p;
  const _QuoteView(this.p);

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    final text = scope.text(p.component, 'text', p.scope, max: 20000);
    final source = scope.text(p.component, 'source', p.scope, max: 120);
    final open = useState(false);
    if (text == null) return const SizedBox.shrink();
    if (scope.flag(p.component, 'collapsed', p.scope) && !open.value) {
      return Align(
        alignment: AlignmentDirectional.centerStart,
        child: Semantics(
          button: true,
          expanded: false,
          child: InkWell(
            onTap: () => open.value = true,
            child: Text(
              '${source == null ? 'Quoted' : 'Quoted from $source'} · Show',
              style: _small(context),
            ),
          ),
        ),
      );
    }
    return _QuoteBox(text: text, source: source);
  }
}

/// A Kiingo object: its icon and title. Not openable in this app.
class _EntityChip extends StatelessWidget {
  final SurfaceEntity entity;
  const _EntityChip({required this.entity});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final label = entity.title ?? _entityNoun(entity.type);
    return Semantics(
      label: '${_entityNoun(entity.type)}: $label',
      excludeSemantics: true,
      child: Container(
        padding: const EdgeInsets.symmetric(
          horizontal: Grid.xxs,
          vertical: Grid.quarter,
        ),
        decoration: BoxDecoration(
          color: colors.primary.withValues(alpha: 0.1),
          borderRadius: BorderRadius.circular(Radii.full),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(_entityIcon(entity.type), size: 14, color: colors.onSurface),
            const SizedBox(width: Grid.half),
            Flexible(
              child: Text(
                label,
                overflow: TextOverflow.ellipsis,
                style: _small(
                  context,
                  color: colors.onSurface,
                ).copyWith(fontWeight: FontWeight.w500),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _EntityRefView extends StatelessWidget {
  final _NodeProps p;
  const _EntityRefView(this.p);

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    final type = scope.string(p.component, 'entityType');
    final id = plainId(scope.value(p.component, 'id', p.scope));
    if (type == null || !surfaceEntityTypes.contains(type) || id == null) {
      return const SizedBox.shrink();
    }
    return Align(
      alignment: AlignmentDirectional.centerStart,
      widthFactor: 1,
      child: _EntityChip(
        entity: SurfaceEntity(
          type: type,
          id: id,
          title: scope.text(p.component, 'label', p.scope, max: 200),
        ),
      ),
    );
  }
}

class _CountdownView extends HookWidget {
  final _NodeProps p;
  const _CountdownView(this.p);

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    final now = useState(DateTime.now());
    useEffect(() {
      final timer = Timer.periodic(
        const Duration(seconds: 30),
        (_) => now.value = DateTime.now(),
      );
      return timer.cancel;
    }, const []);
    final target = parseSurfaceDate(
      scope.value(p.component, 'target', p.scope),
    );
    if (target == null) return const SizedBox.shrink();
    final label = scope.text(p.component, 'label', p.scope, max: 80);
    return Text.rich(
      TextSpan(
        style: _body(context),
        children: [
          if (label != null)
            TextSpan(
              text: '$label ',
              style: TextStyle(color: context.colors.onSurfaceVariant),
            ),
          TextSpan(
            text: countdownText(
              target,
              since: scope.string(p.component, 'mode') == 'since',
              now: now.value,
            ),
            style: const TextStyle(
              fontFeatures: [FontFeature.tabularFigures()],
            ),
          ),
        ],
      ),
    );
  }
}
