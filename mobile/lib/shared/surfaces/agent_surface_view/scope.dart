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

  /// What a send_message [action] shows and sends (79 M1). A Link passes
  /// the words it [shown]s instead of the action's label, and whether its
  /// raw text was [shownHidden].
  MessageSend sendOf(
    SurfaceAction action, {
    String? shown,
    bool shownHidden = false,
  }) => messageSend(
    shown ?? action.label,
    shown == null ? action.text : action.text ?? action.label,
    hidden: action.hidden || shownHidden,
    agentName: agentName,
  );

  /// The card's agent, from the message signer's profile (79), never the
  /// surface's own name for itself.
  String? get agentName => host.agentName;

  /// The tap a message from control [actionId] carries.
  SurfaceTap tapOf(String actionId) => SurfaceTap(
    surfaceId: surface.id,
    actionId: actionId,
    revision: surface.revision,
  );

  /// Whether a tap does something here. View only: `open` (a link or the
  /// large sheet) and `send_message` (an ordinary message from the person,
  /// only the words drawn on the control) work; everything else waits for
  /// the Kiingo app. A Card or List row ([sends] false) never sends, and a
  /// Link sends only when its [shown] words are the words sent.
  bool canTap(
    SurfaceAction action, {
    bool sends = true,
    String? shown,
    bool shownHidden = false,
  }) => switch (action.kind) {
    SurfaceActionKind.open => switch (action.target) {
      SurfaceOpenUrl() => true,
      SurfaceOpenExpanded() => host.openExpanded != null,
      SurfaceOpenEntity() || null => false,
    },
    SurfaceActionKind.sendMessage =>
      sends &&
          acceptsTaps(surface) &&
          host.sendMessage != null &&
          switch (sendOf(action, shown: shown, shownHidden: shownHidden)) {
            LabelSend() => true,
            CaptionSend() => shown == null,
            BlockedSend() => false,
          },
    _ => false,
  };

  /// [drawn] is what the control showed it sends, at the frame tapped.
  /// Only an action of the surface on screen now runs (79): a menu or
  /// control left open across a new read never runs what it held.
  void perform(
    BuildContext context,
    SurfaceAction action, {
    bool sends = true,
    String? shown,
    bool shownHidden = false,
    MessageSend? drawn,
  }) {
    if (!_isCurrent(context) ||
        !identical(surface.actions[action.id], action) ||
        !canTap(action, sends: sends, shown: shown, shownHidden: shownHidden)) {
      return;
    }
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
        final send = sendOf(action, shown: shown, shownHidden: shownHidden);
        final text = sentText(send);
        if (text == null ||
            (drawn != null && sentText(drawn) != text) ||
            !_sendCounts(context, action.id)) {
          return;
        }
        host.sendMessage?.call(text, tapOf(action.id));
      default:
        break;
    }
  }

  /// Sends a suggestion chip's words, tagged with its tap id.
  void sendChip(
    BuildContext context,
    SurfaceComponent component,
    int index,
    MessageSend send,
  ) {
    final text = sentText(send);
    final actionId = chipActionId(component.id, index);
    if (text == null ||
        !acceptsTaps(surface) ||
        !_sendCounts(context, actionId)) {
      return;
    }
    host.sendMessage?.call(text, tapOf(actionId));
  }

  /// Whether a send tap on control [actionId] counts (79): the card on
  /// screen is still this read (the words tapped are the words drawn), the
  /// revision has settled for [SurfaceHost.tapSettle], and the control has
  /// not sent from it before.
  bool _sendCounts(BuildContext context, String actionId) {
    if (!_isCurrent(context)) return false;
    return claimSurfaceSend(
      surface.id,
      surface.revision,
      actionId,
      settle: host.tapSettle,
    );
  }

  /// Whether the card on screen at [context] still shows this read, and no
  /// newer revision of the surface has been drawn anywhere.
  bool _isCurrent(BuildContext context) =>
      context.mounted &&
      isNewestSurfaceRevision(surface.id, surface.revision) &&
      identical(
        context.getInheritedWidgetOfExactType<_SurfaceScope>()?.data.surface,
        surface,
      );

  /// This surface read's diffs, worked out once each (79 S4).
  SurfaceDiffMemo get diffs => _diffMemos[surface] ??= SurfaceDiffMemo();

  /// [text] parsed once per surface read, or null once this surface's
  /// [mdParseBudget] is spent (then it shows as written, 79 S2).
  List<MdBlock>? markdownOf(String text) {
    final cache = _markdownCaches[surface] ??= _MarkdownCache();
    if (cache.parsed.containsKey(text)) return cache.parsed[text];
    List<MdBlock>? blocks;
    if (text.length <= cache.left) {
      cache.left -= text.length;
      blocks = parseMarkdown(text);
    }
    cache.parsed[text] = blocks;
    return blocks;
  }

  /// Opens an https or allowed Kiingo link, confirmed first with the URL
  /// as parsed (the one that opens).
  void openLink(BuildContext context, String raw) {
    final url = openableUrl(raw);
    if (url == null) return;
    if (!isOutsideUrl(url)) {
      host.openUrl(url);
      return;
    }
    final https = url.startsWith('https://');
    unawaited(
      showDialog<bool>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          title: Text(https ? 'Open ${urlHost(url)}?' : 'Open in Kiingo?'),
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
              child: Text(https ? 'Open in Browser' : 'Open'),
            ),
          ],
        ),
      ).then((open) {
        if (open == true) host.openUrl(url);
      }),
    );
  }
}

/// One surface's parsed Markdown and what is left of its parse budget.
class _MarkdownCache {
  var left = mdParseBudget;
  final parsed = <String, List<MdBlock>?>{};
}

final _markdownCaches = Expando<_MarkdownCache>('surface markdown');

final _diffMemos = Expando<SurfaceDiffMemo>('surface diffs');

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
