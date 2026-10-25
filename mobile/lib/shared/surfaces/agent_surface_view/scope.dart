part of '../agent_surface_view.dart';

/// What every node reads: the surface, the host and the rules for taps.
/// This app draws surfaces view only, so nothing here edits.
class _SurfaceContext {
  final Surface surface;

  /// The host the surface came from; images load only from there.
  final String origin;
  final SurfaceHost host;
  final bool expanded;

  const _SurfaceContext({
    required this.surface,
    required this.origin,
    required this.host,
    required this.expanded,
  });

  Map<String, Object?> get data => surface.data;

  Object? value(SurfaceComponent component, String key, Pointer scope) =>
      resolveProp(component.props[key], data, scope);

  /// A prop as plain text (bound or literal); null when empty.
  String? text(
    SurfaceComponent component,
    String key,
    Pointer scope, {
    int max = 4000,
  }) => propText(component.props[key], data, scope, max: max);

  /// Any value (an item field, bound or literal) as plain text.
  String? textOf(Object? prop, Pointer scope, {int max = 4000}) =>
      propText(prop, data, scope, max: max);

  num? number(SurfaceComponent component, String key, Pointer scope) =>
      propNumber(component.props[key], data, scope);

  bool flag(SurfaceComponent component, String key, Pointer scope) =>
      propBool(component.props[key], data, scope);

  /// A literal string prop (enums such as `variant`, `kind`, `style`).
  String? string(SurfaceComponent component, String key) =>
      asString(component.props[key]);

  /// Whether the prop reads outside content (§10: drawn as a Quote).
  bool isUntrusted(SurfaceComponent component, String key, Pointer scope) {
    final pointer = bindingOf(component.props[key], scope);
    return pointer != null && isUntrustedPath(surface, pointer);
  }

  List<SurfaceChildRef> children(
    SurfaceComponent component,
    Pointer scope, [
    String key = 'children',
  ]) => childrenOf(component.props[key], data, scope);

  /// An item list prop (`items`, `options`, `rows`…), literal or bound.
  List<Object?> list(SurfaceComponent component, String key, Pointer scope) {
    final value = this.value(component, key, scope);
    return value is List
        ? value.take(surfaceMaxRepeats).toList(growable: false)
        : const [];
  }

  SurfaceAction? action(Object? id) =>
      id is String ? surface.actions[id] : null;

  /// The bound value of an input.
  Object? inputValue(SurfaceComponent component, Pointer scope) {
    final pointer = bindingOf(component.props['value'], scope);
    return pointer == null ? null : readAt(data, pointer);
  }

  /// Whether a tap does something here. View only: `open` (a link or the
  /// large sheet) and `send_message` (an ordinary message from the person)
  /// work; everything else waits for the Kiingo app.
  bool canTap(SurfaceAction action) => switch (action.kind) {
    SurfaceActionKind.open => switch (action.target) {
      SurfaceOpenUrl() => true,
      SurfaceOpenExpanded() => host.openExpanded != null,
      SurfaceOpenEntity() || null => false,
    },
    SurfaceActionKind.sendMessage =>
      acceptsTaps(surface) && host.sendMessage != null,
    _ => false,
  };

  void perform(BuildContext context, SurfaceAction action) {
    if (!canTap(action)) return;
    switch (action.kind) {
      case SurfaceActionKind.open:
        switch (action.target) {
          case SurfaceOpenUrl(:final url):
            openLink(context, url);
          case SurfaceOpenExpanded():
            host.openExpanded?.call();
          case SurfaceOpenEntity() || null:
            break;
        }
      case SurfaceActionKind.sendMessage:
        host.sendMessage?.call(action.text ?? action.label);
      default:
        break;
    }
  }

  /// Opens an https or Kiingo link; an outside host is confirmed first.
  void openLink(BuildContext context, String raw) {
    final url = openableUrl(raw);
    if (url == null) return;
    if (!isOutsideUrl(url)) {
      host.openUrl(url);
      return;
    }
    unawaited(
      showDialog<bool>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          title: Text('Open ${urlHost(url)}?'),
          content: Text(
            url,
            style: dialogContext.textTheme.bodyMedium?.copyWith(
              color: dialogContext.colors.onSurfaceVariant,
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: const Text('Cancel'),
            ),
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(true),
              child: const Text('Open in Browser'),
            ),
          ],
        ),
      ).then((open) {
        if (open == true) host.openUrl(url);
      }),
    );
  }
}

class _SurfaceScope extends InheritedWidget {
  final _SurfaceContext data;

  const _SurfaceScope({required this.data, required super.child});

  static _SurfaceContext of(BuildContext context) {
    final scope = context.dependOnInheritedWidgetOfExactType<_SurfaceScope>();
    assert(scope != null, 'Surface nodes render inside AgentSurfaceView.');
    return scope!.data;
  }

  @override
  bool updateShouldNotify(_SurfaceScope oldWidget) =>
      !identical(data.surface, oldWidget.data.surface) ||
      data.origin != oldWidget.data.origin ||
      data.host != oldWidget.data.host ||
      data.expanded != oldWidget.data.expanded;
}

/// Props every component view gets.
typedef _NodeProps = ({SurfaceComponent component, Pointer scope, int depth});

/// `gap: none | xs | sm | md | lg | xl` in points.
double _gapOf(String? gap) => switch (gap) {
  'none' => 0,
  'xs' => Grid.half,
  'sm' => Grid.half + Grid.quarter,
  'lg' => Grid.xs,
  'xl' => Grid.sm,
  _ => Grid.xxs + Grid.quarter,
};
