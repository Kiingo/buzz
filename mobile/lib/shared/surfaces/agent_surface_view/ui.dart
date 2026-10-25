part of '../agent_surface_view.dart';

// The app's own controls for surfaces. Colours come from the app's theme
// only (§10.1: agents never set colours, CSS or HTML).

/// Text colour for a tone.
Color _toneColor(BuildContext context, String? tone) => switch (tone) {
  'success' => context.appColors.success,
  'warning' => context.appColors.warning,
  'danger' || 'error' => context.colors.error,
  'info' => context.colors.primary,
  'muted' => context.colors.onSurfaceVariant,
  _ => context.colors.onSurface,
};

/// A quiet background for a tone (badges, callouts).
Color _toneBackground(BuildContext context, String? tone) => switch (tone) {
  'success' ||
  'warning' ||
  'danger' ||
  'error' ||
  'info' => _toneColor(context, tone).withValues(alpha: 0.12),
  'muted' => context.colors.surfaceContainerHighest,
  _ => context.colors.secondaryContainer,
};

Color _toneOnBackground(BuildContext context, String? tone) => switch (tone) {
  null || 'default' => context.colors.onSecondaryContainer,
  _ => _toneColor(context, tone),
};

IconData _toneIcon(String? tone) => switch (tone) {
  'success' => BuzzIcons.circleCheck,
  'warning' => BuzzIcons.triangleAlert,
  'danger' || 'error' => BuzzIcons.circleX,
  _ => BuzzIcons.circleAlert,
};

/// The catalog's icon names drawn with the app's icons; an unknown name is
/// a plain dot.
IconData _catalogIcon(String? name) => switch (name) {
  'add' => BuzzIcons.plus,
  'alert' => BuzzIcons.circleAlert,
  'archive' => BuzzIcons.archive,
  'arrow_down' => BuzzIcons.arrowDown,
  'arrow_left' => BuzzIcons.arrowLeft,
  'arrow_right' => BuzzIcons.chevronRight,
  'arrow_up' => BuzzIcons.arrowUp,
  'attachment' => BuzzIcons.link,
  'bell' => BuzzIcons.bell,
  'bolt' => BuzzIcons.activity,
  'bookmark' => BuzzIcons.flag,
  'building' => BuzzIcons.folder,
  'calendar' => BuzzIcons.calendarClock,
  'chart' => BuzzIcons.activity,
  'chat' => BuzzIcons.messageCircle,
  'check' => BuzzIcons.check,
  'check_circle' => BuzzIcons.circleCheck,
  'chevron_down' => BuzzIcons.chevronDown,
  'chevron_right' => BuzzIcons.chevronRight,
  'clipboard' => BuzzIcons.copy,
  'clock' => BuzzIcons.clock,
  'close' => BuzzIcons.x,
  'code' => BuzzIcons.code,
  'copy' => BuzzIcons.copy,
  'dollar' => BuzzIcons.circleDot,
  'download' => BuzzIcons.download,
  'edit' => BuzzIcons.pencil,
  'email' => BuzzIcons.mail,
  'external_link' => BuzzIcons.externalLink,
  'file' => BuzzIcons.file,
  'filter' => BuzzIcons.search,
  'flag' => BuzzIcons.flag,
  'folder' => BuzzIcons.folder,
  'globe' => BuzzIcons.compass,
  'heart' => BuzzIcons.heart,
  'help' => BuzzIcons.circleAlert,
  'home' => BuzzIcons.house300,
  'image' => BuzzIcons.image,
  'info' => BuzzIcons.circleAlert,
  'link' => BuzzIcons.link,
  'list' => BuzzIcons.fileText,
  'location' => BuzzIcons.compass,
  'lock' => BuzzIcons.lock,
  'more' => BuzzIcons.ellipsis,
  'people' => BuzzIcons.users,
  'person' => BuzzIcons.user,
  'phone' => BuzzIcons.mic,
  'play' => BuzzIcons.play,
  'refresh' => BuzzIcons.refreshCw,
  'remove' => BuzzIcons.x,
  'reply' => BuzzIcons.messageSquareReply,
  'search' => BuzzIcons.search,
  'send' => BuzzIcons.messageSquare,
  'settings' => BuzzIcons.settings,
  'share' => BuzzIcons.share2,
  'sparkles' => BuzzIcons.sparkles,
  'star' => BuzzIcons.star,
  'tag' => BuzzIcons.hash,
  'task' => BuzzIcons.checkCheck,
  'thumbs_down' => BuzzIcons.arrowDown,
  'thumbs_up' => BuzzIcons.arrowUp,
  'trash' => BuzzIcons.trash2,
  'trend_down' => BuzzIcons.arrowDown,
  'trend_up' => BuzzIcons.arrowUp,
  'upload' => BuzzIcons.arrowUp,
  'video' => BuzzIcons.video,
  'warning' => BuzzIcons.triangleAlert,
  _ => BuzzIcons.circleDot,
};

IconData _entityIcon(String type) => switch (type) {
  'task' => BuzzIcons.checkCheck,
  'project' => BuzzIcons.folder,
  'person' => BuzzIcons.user,
  'agent' => BuzzIcons.sparkles,
  'email_thread' => BuzzIcons.mail,
  'file' => BuzzIcons.file,
  'calendar_event' => BuzzIcons.calendarClock,
  'deal' => BuzzIcons.circleDot,
  'company' => BuzzIcons.folder,
  _ => BuzzIcons.circleDot,
};

String _entityNoun(String type) => switch (type) {
  'task' => 'Task',
  'project' => 'Project',
  'person' => 'Person',
  'agent' => 'Agent',
  'email_thread' => 'Email',
  'file' => 'File',
  'calendar_event' => 'Event',
  'deal' => 'Deal',
  'company' => 'Company',
  _ => 'Item',
};

TextStyle _small(BuildContext context, {Color? color}) =>
    bodyExtraSmallTextStyle.copyWith(
      color: color ?? context.colors.onSurfaceVariant,
    );

TextStyle _body(BuildContext context, {Color? color, FontWeight? weight}) =>
    (context.textTheme.bodyMedium ?? const TextStyle()).copyWith(
      color: color,
      fontWeight: weight,
    );

/// A tinted pill.
class _Badge extends StatelessWidget {
  final String text;
  final String? tone;
  final String? icon;

  const _Badge({required this.text, this.tone, this.icon});

  @override
  Widget build(BuildContext context) {
    final foreground = _toneOnBackground(context, tone);
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: Grid.xxs,
        vertical: Grid.quarter,
      ),
      decoration: BoxDecoration(
        color: _toneBackground(context, tone),
        borderRadius: BorderRadius.circular(Radii.full),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[
            Icon(_catalogIcon(icon), size: 12, color: foreground),
            const SizedBox(width: Grid.half),
          ],
          Flexible(
            child: Text(
              text,
              overflow: TextOverflow.ellipsis,
              style: _small(
                context,
                color: foreground,
              ).copyWith(fontWeight: FontWeight.w500),
            ),
          ),
        ],
      ),
    );
  }
}

/// Outside material, always quoted (§10): a bar, the source, then plain
/// [text] or a [child] drawn inside the frame.
class _QuoteBox extends StatelessWidget {
  final String? text;
  final Widget? child;
  final String? source;

  const _QuoteBox({this.text, this.child, this.source});

  @override
  Widget build(BuildContext context) {
    final muted = context.colors.onSurfaceVariant;
    return Semantics(
      label: source == null ? 'Quoted' : 'Quoted from $source',
      child: Container(
        padding: const EdgeInsetsDirectional.only(start: Grid.xxs),
        decoration: BoxDecoration(
          border: BorderDirectional(
            start: BorderSide(color: muted.withValues(alpha: 0.4), width: 3),
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            ExcludeSemantics(
              child: Text(
                source == null ? 'Quoted' : 'Quoted from $source',
                style: _small(context),
              ),
            ),
            if (text case final text?)
              Text(text, style: _body(context, color: muted)),
            ?child,
          ],
        ),
      ),
    );
  }
}

/// The app's button in a surface style.
class _SurfaceButton extends StatelessWidget {
  final String label;
  final String? semanticLabel;
  final SurfaceActionStyle style;
  final IconData? icon;
  final VoidCallback? onPressed;
  final bool fullWidth;

  /// The words a tap sends when they differ from [label] ("Sends: …"),
  /// drawn in full inside the button, so they are on screen whenever the
  /// button is and read with it (79 M1).
  final String? caption;

  const _SurfaceButton({
    required this.label,
    this.semanticLabel,
    this.style = SurfaceActionStyle.secondary,
    this.icon,
    this.onPressed,
    this.fullWidth = false,
    this.caption,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final row = Row(
      mainAxisSize: fullWidth ? MainAxisSize.max : MainAxisSize.min,
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        if (icon != null) ...[
          Icon(icon, size: 16),
          const SizedBox(width: Grid.half + Grid.quarter),
        ],
        // Never ellipsized: a label may be the words a tap sends (79 M1).
        Flexible(child: Text(label, softWrap: true)),
      ],
    );
    final words = caption;
    final Widget child = words == null
        ? row
        : Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              row,
              const SizedBox(height: Grid.quarter),
              Text(
                words,
                softWrap: true,
                style: context.textTheme.bodySmall?.copyWith(
                  color: colors.onSurfaceVariant,
                ),
              ),
            ],
          );
    const padding = EdgeInsets.symmetric(
      horizontal: Grid.twelve,
      vertical: Grid.xxs,
    );
    final shape = RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(Radii.md),
    );
    final Widget button = switch (style) {
      SurfaceActionStyle.primary => FilledButton(
        onPressed: onPressed,
        style: FilledButton.styleFrom(padding: padding, shape: shape),
        child: child,
      ),
      SurfaceActionStyle.destructive => FilledButton(
        onPressed: onPressed,
        style: FilledButton.styleFrom(
          padding: padding,
          shape: shape,
          backgroundColor: colors.error,
          foregroundColor: colors.onError,
        ),
        child: child,
      ),
      SurfaceActionStyle.plain => TextButton(
        onPressed: onPressed,
        style: TextButton.styleFrom(
          padding: const EdgeInsets.symmetric(horizontal: Grid.half),
          minimumSize: Size.zero,
          tapTargetSize: MaterialTapTargetSize.padded,
        ),
        child: child,
      ),
      SurfaceActionStyle.secondary => OutlinedButton(
        onPressed: onPressed,
        style: OutlinedButton.styleFrom(padding: padding, shape: shape),
        child: child,
      ),
    };
    final sized = fullWidth
        ? SizedBox(width: double.infinity, child: button)
        : button;
    return semanticLabel == null
        ? sized
        : Semantics(
            label: semanticLabel,
            button: true,
            excludeSemantics: true,
            enabled: onPressed != null,
            onTap: onPressed,
            child: sized,
          );
  }
}

/// A bordered card body.
class _Panel extends StatelessWidget {
  final Widget child;

  const _Panel({required this.child});

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(Grid.twelve),
    decoration: BoxDecoration(
      color: context.colors.surface,
      border: Border.all(color: context.colors.outlineVariant),
      borderRadius: BorderRadius.circular(Radii.lg),
    ),
    child: child,
  );
}

/// "This needs a newer app" plus Open on web: never a blank or a crash.
class _NewerAppNotice extends StatelessWidget {
  final String? webUrl;

  /// Past [surfaceMaxNodes]: says it is too big to show here instead.
  final bool tooBig;

  const _NewerAppNotice({this.webUrl, this.tooBig = false});

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    final url = webUrl;
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: Grid.xxs + Grid.quarter,
        vertical: Grid.xxs,
      ),
      decoration: BoxDecoration(
        color: context.colors.surfaceContainerHighest.withValues(alpha: 0.6),
        borderRadius: BorderRadius.circular(Radii.md),
      ),
      child: Row(
        children: [
          Expanded(
            child: _NewerAppRow(
              text: tooBig ? 'This card is too big to show here.' : null,
            ),
          ),
          if (url != null)
            _SurfaceButton(
              label: 'Open on web',
              style: SurfaceActionStyle.plain,
              onPressed: () => scope.openLink(context, url),
            ),
        ],
      ),
    );
  }
}
