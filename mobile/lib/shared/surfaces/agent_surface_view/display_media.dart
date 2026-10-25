part of '../agent_surface_view.dart';

// §4.2 media and places. Images and media come only from the signed proxy
// on the host that served the surface; nothing loads from anywhere else
// (no map tiles, no link previews fetched by the app).

/// An image from the signed proxy, else its alt text. Loaded with no
/// credentials as a checked raster type; an expired signature reads the
/// surface again (at most once a minute, by the host).
class _ProxyImage extends HookConsumerWidget {
  final Object? url;
  final String alt;
  final bool cover;

  /// width / height
  final double? aspect;

  const _ProxyImage({
    required this.url,
    required this.alt,
    this.cover = false,
    this.aspect,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final scope = _SurfaceScope.of(context);
    final proxied = proxiedMediaUrl(url, scope.origin);
    final result = proxied == null
        ? null
        : ref.watch(surfaceImageProvider(proxied)).value;
    final expired = result is SurfaceImageExpired;
    useEffect(() {
      if (expired) scope.host.refresh?.call();
      return null;
    }, [expired, proxied]);
    final Widget child;
    if (result case SurfaceImageBytes(
      :final bytes,
      :final width,
      :final height,
    )) {
      // Decoded at the size drawn, never the full bitmap, and never more
      // pixels in all than the box holds (79 S3).
      child = LayoutBuilder(
        builder: (context, constraints) {
          final ratio = MediaQuery.devicePixelRatioOf(context);
          final drawn = constraints.hasBoundedWidth
              ? (constraints.maxWidth * ratio).ceil()
              : (560 * ratio).ceil();
          return Image.memory(
            bytes,
            cacheWidth: surfaceImageDecodeWidth(
              width: width,
              height: height,
              boxWidth: drawn,
              boxHeight: (_imageMaxHeight * ratio).ceil(),
            ),
            fit: cover ? BoxFit.cover : BoxFit.contain,
            width: double.infinity,
            semanticLabel: alt.isEmpty ? null : alt,
            excludeFromSemantics: alt.isEmpty,
            gaplessPlayback: true,
            errorBuilder: (context, _, _) => _ImageAlt(alt: alt),
          );
        },
      );
    } else {
      child = _ImageAlt(alt: alt);
    }
    final rounded = ClipRRect(
      borderRadius: BorderRadius.circular(Radii.md),
      child: child,
    );
    final ratio = aspect;
    return ConstrainedBox(
      constraints: const BoxConstraints(maxHeight: _imageMaxHeight),
      child: ratio == null
          ? rounded
          : AspectRatio(aspectRatio: ratio, child: rounded),
    );
  }
}

/// The tallest an image is drawn (logical pixels).
const _imageMaxHeight = 320.0;

class _ImageAlt extends StatelessWidget {
  final String alt;
  const _ImageAlt({required this.alt});

  @override
  Widget build(BuildContext context) {
    final muted = context.colors.onSurfaceVariant;
    return Semantics(
      image: alt.isNotEmpty,
      label: alt.isEmpty ? null : alt,
      excludeSemantics: true,
      child: Container(
        constraints: const BoxConstraints(minHeight: Grid.lg),
        padding: const EdgeInsets.all(Grid.xxs),
        color: context.colors.surfaceContainerHighest.withValues(alpha: 0.6),
        child: Row(
          children: [
            Icon(BuzzIcons.image, size: 16, color: muted),
            const SizedBox(width: Grid.xxs),
            Expanded(
              child: Text(
                alt.isEmpty ? 'Image' : alt,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: _small(context),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ImageView extends StatelessWidget {
  final _NodeProps p;
  const _ImageView(this.p);

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    return _ProxyImage(
      url: scope.value(p.component, 'url', p.scope),
      alt: scope.text(p.component, 'alt', p.scope, max: 300) ?? '',
      cover: scope.string(p.component, 'fit') == 'cover',
      aspect: switch (scope.string(p.component, 'aspect')) {
        '1:1' => 1,
        '4:3' => 4 / 3,
        '3:2' => 3 / 2,
        '16:9' => 16 / 9,
        _ => null,
      },
    );
  }
}

class _ImageGalleryView extends StatelessWidget {
  final _NodeProps p;
  const _ImageGalleryView(this.p);

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    final images = scope.list(p.component, 'images', p.scope).take(60).toList();
    final columns = (scope.number(p.component, 'columns', p.scope) ?? 3)
        .round()
        .clamp(1, 6);
    Object? urlOf(Object? item) =>
        resolveProp(fieldOf(item, 'url'), scope.data, p.scope);
    String altOf(Object? item) =>
        scope.textOf(fieldOf(item, 'alt'), p.scope, max: 300) ?? '';
    void enlarge(Object? item) => unawaited(
      showBuzzModalBottomSheet<void>(
        context: context,
        title: altOf(item).isEmpty ? 'Image' : altOf(item),
        isScrollControlled: true,
        builder: (sheetContext) => _SurfaceScope(
          data: scope,
          child: Padding(
            padding: const EdgeInsets.all(Grid.xs),
            child: _ProxyImage(url: urlOf(item), alt: altOf(item)),
          ),
        ),
      ),
    );
    return LayoutBuilder(
      builder: (context, constraints) {
        const gap = Grid.half + Grid.quarter;
        final cell = (constraints.maxWidth - gap * (columns - 1)) / columns;
        return Wrap(
          spacing: gap,
          runSpacing: gap,
          children: [
            for (final (index, item) in images.indexed)
              SizedBox(
                width: cell,
                child: Semantics(
                  button: true,
                  label: altOf(item).isEmpty
                      ? 'Image ${index + 1}'
                      : altOf(item),
                  excludeSemantics: true,
                  child: InkWell(
                    onTap: () => enlarge(item),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        _ProxyImage(
                          url: urlOf(item),
                          alt: altOf(item),
                          cover: true,
                          aspect: 1,
                        ),
                        if (scope.textOf(
                              fieldOf(item, 'caption'),
                              p.scope,
                              max: 200,
                            )
                            case final caption?)
                          Text(
                            caption,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: context.textTheme.labelSmall?.copyWith(
                              color: context.colors.onSurfaceVariant,
                            ),
                          ),
                      ],
                    ),
                  ),
                ),
              ),
          ],
        );
      },
    );
  }
}

class _FileRow extends StatelessWidget {
  final Object? item;
  const _FileRow({required this.item});

  @override
  Widget build(BuildContext context) {
    final name = plainText(fieldOf(item, 'name'), 200) ?? 'File';
    final size = asNumber(fieldOf(item, 'size'));
    final detail = [
      ?plainText(fieldOf(item, 'contentType'), 80),
      if (size != null) formatSurfaceBytes(size),
    ].join(' · ');
    return MergeSemantics(
      child: Row(
        children: [
          Icon(
            BuzzIcons.file,
            size: 16,
            color: context.colors.onSurfaceVariant,
          ),
          const SizedBox(width: Grid.xxs + Grid.quarter),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: _body(context),
                ),
                if (detail.isNotEmpty) Text(detail, style: _small(context)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _FileListView extends StatelessWidget {
  final _NodeProps p;
  const _FileListView(this.p);

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    final files = scope.list(p.component, 'files', p.scope).take(100).toList();
    final empty = scope.text(p.component, 'emptyText', p.scope, max: 200);
    if (files.isEmpty) {
      return empty == null
          ? const SizedBox.shrink()
          : Text(empty, style: _small(context));
    }
    return _Gapped(
      gap: Grid.half + Grid.quarter,
      children: [for (final item in files) _FileRow(item: item)],
    );
  }
}

/// Audio or video: its title, and "Open in Kiingo" (79 S7). This app
/// doesn't play surface media: the native players follow redirects and
/// skip the type and size checks images get.
class _MediaView extends StatelessWidget {
  final _NodeProps p;
  const _MediaView(this.p);

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    final title =
        scope.text(p.component, 'title', p.scope, max: 200) ?? 'Media';
    final video = scope.string(p.component, 'kind') == 'video';
    final webUrl = scope.surface.webUrl;
    return _Panel(
      child: Row(
        children: [
          Icon(
            video ? BuzzIcons.video : BuzzIcons.headphones,
            size: 16,
            color: context.colors.onSurfaceVariant,
          ),
          const SizedBox(width: Grid.xxs + Grid.quarter),
          Expanded(child: Text(title, style: _body(context))),
          if (webUrl != null)
            _SurfaceButton(
              label: 'Open in Kiingo',
              semanticLabel: 'Open $title in Kiingo',
              style: SurfaceActionStyle.plain,
              onPressed: () => scope.openLink(context, webUrl),
            ),
        ],
      ),
    );
  }
}

class _LinkPreviewView extends StatelessWidget {
  final _NodeProps p;
  const _LinkPreviewView(this.p);

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    final link = openableUrl(
      scope.text(p.component, 'url', p.scope, max: 2048),
    );
    final title = scope.text(p.component, 'title', p.scope, max: 200);
    final description = scope.text(
      p.component,
      'description',
      p.scope,
      max: 300,
    );
    final image = scope.value(p.component, 'imageUrl', p.scope);
    final body = _Panel(
      child: _Gapped(
        gap: Grid.half + Grid.quarter,
        align: CrossAxisAlignment.start,
        children: [
          if (image != null)
            ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 128),
              child: _ProxyImage(url: image, alt: '', cover: true),
            ),
          if (title != null)
            Text(
              title,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: _body(context, weight: FontWeight.w600),
            ),
          if (description != null)
            Text(
              description,
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
              style: _small(context, color: context.colors.onSurface),
            ),
          Text(link == null ? '' : urlHost(link), style: _small(context)),
        ],
      ),
    );
    if (link == null) return body;
    return Semantics(
      link: true,
      hint: 'Opens in the browser',
      child: Material(
        type: MaterialType.transparency,
        child: InkWell(
          borderRadius: BorderRadius.circular(Radii.lg),
          onTap: () => scope.openLink(context, link),
          child: body,
        ),
      ),
    );
  }
}

typedef _Pin = ({double lat, double lng, String label});

/// Pins drawn on a plain plot (no map tiles are fetched: nothing loads from
/// outside the app), with the places and "Open in Maps".
class _MapView extends StatelessWidget {
  final _NodeProps p;
  const _MapView(this.p);

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    var raw = scope.list(p.component, 'pins', p.scope);
    final single = asObject(scope.value(p.component, 'pins', p.scope));
    if (raw.isEmpty && single != null) raw = [single];
    final pins = <_Pin>[
      for (final item in raw.take(50))
        if ((asNumber(fieldOf(item, 'lat')), asNumber(fieldOf(item, 'lng')))
            case (final lat?, final lng?)
            when lat.abs() <= 90 && lng.abs() <= 180)
          (
            lat: lat.toDouble(),
            lng: lng.toDouble(),
            label: plainText(fieldOf(item, 'label'), 80) ?? '',
          ),
    ];
    if (pins.isEmpty) return const SizedBox.shrink();
    final first = pins.first;
    final mapsLink = Uri.https('maps.apple.com', '/', {
      'll': '${first.lat},${first.lng}',
      'q': first.label.isEmpty ? 'Pin' : first.label,
    }).toString();
    final names = pins
        .map(
          (pin) => pin.label.isNotEmpty
              ? pin.label
              : '${pin.lat.toStringAsFixed(3)}, ${pin.lng.toStringAsFixed(3)}',
        )
        .join(' · ');
    return _Panel(
      child: _Gapped(
        children: [
          Semantics(
            image: true,
            label: 'Map: $names',
            excludeSemantics: true,
            child: ClipRRect(
              borderRadius: BorderRadius.circular(Radii.md),
              child: SizedBox(
                height: 160,
                width: double.infinity,
                child: CustomPaint(
                  painter: _MapPainter(
                    pins: pins,
                    route: scope.flag(p.component, 'route', p.scope),
                    background: context.colors.surfaceContainerHighest,
                    line: context.colors.primary,
                    pin: context.colors.error,
                  ),
                ),
              ),
            ),
          ),
          Row(
            children: [
              Expanded(child: Text(names, style: _small(context))),
              _SurfaceButton(
                label: 'Open in Maps',
                style: SurfaceActionStyle.plain,
                onPressed: () => scope.openLink(context, mapsLink),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _MapPainter extends CustomPainter {
  final List<_Pin> pins;
  final bool route;
  final Color background;
  final Color line;
  final Color pin;

  const _MapPainter({
    required this.pins,
    required this.route,
    required this.background,
    required this.line,
    required this.pin,
  });

  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(Offset.zero & size, Paint()..color = background);
    final lats = pins.map((pin) => pin.lat);
    final lngs = pins.map((pin) => pin.lng);
    final minLat = lats.reduce(math.min);
    final maxLat = lats.reduce(math.max);
    final minLng = lngs.reduce(math.min);
    final maxLng = lngs.reduce(math.max);
    final spanLat = math.max(maxLat - minLat, 0.01);
    final spanLng = math.max(maxLng - minLng, 0.01);
    const pad = 0.15;
    final w = size.width - 40;
    final h = size.height - 40;
    Offset at(_Pin p) => Offset(
      20 + ((p.lng - minLng) / spanLng) * w * (1 - pad) + w * pad / 2,
      20 + ((maxLat - p.lat) / spanLat) * h * (1 - pad) + h * pad / 2,
    );
    if (route && pins.length > 1) {
      final path = Path()..moveTo(at(pins.first).dx, at(pins.first).dy);
      for (final p in pins.skip(1)) {
        path.lineTo(at(p).dx, at(p).dy);
      }
      canvas.drawPath(
        path,
        Paint()
          ..color = line
          ..style = PaintingStyle.stroke
          ..strokeWidth = 3,
      );
    }
    for (final p in pins) {
      canvas.drawCircle(at(p), 5, Paint()..color = pin);
    }
  }

  @override
  bool shouldRepaint(_MapPainter oldDelegate) =>
      oldDelegate.pins != pins ||
      oldDelegate.route != route ||
      oldDelegate.background != background;
}
