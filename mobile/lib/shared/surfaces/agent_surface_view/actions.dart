part of '../agent_surface_view.dart';

// §4.4 Actions. Labels are the agent's plain text. View only: links,
// the large sheet and plain messages work here; run buttons say "Open in
// the Kiingo app", and changes wait for Kiingo.

SurfaceActionStyle? _styleOf(String? raw) => switch (raw) {
  'primary' => SurfaceActionStyle.primary,
  'secondary' => SurfaceActionStyle.secondary,
  'destructive' => SurfaceActionStyle.destructive,
  'plain' => SurfaceActionStyle.plain,
  _ => null,
};

class _ActionButton extends StatelessWidget {
  final SurfaceAction action;
  final Pointer scope;
  final SurfaceActionStyle? style;
  final String? icon;
  final bool fullWidth;

  const _ActionButton({
    required this.action,
    required this.scope,
    this.style,
    this.icon,
    this.fullWidth = false,
  });

  @override
  Widget build(BuildContext context) {
    final surface = _SurfaceScope.of(context);
    final runOff = action.kind == SurfaceActionKind.run;
    final iconName = icon ?? action.icon;
    final send = action.kind == SurfaceActionKind.sendMessage
        ? surface.sendOf(action)
        : null;
    final button = _SurfaceButton(
      label: action.label,
      style: style ?? action.style,
      icon: iconName == null ? null : _catalogIcon(iconName),
      fullWidth: fullWidth,
      // The words sent, inside the button (79 M1).
      caption: send is CaptionSend ? sendsCaption(send.text) : null,
      onPressed: surface.canTap(action)
          ? () => surface.perform(context, action, drawn: send)
          : null,
    );
    final String? note;
    if (runOff) {
      note = runUnavailableText;
    } else if (send is BlockedSend) {
      note = sendBlockedText(send);
    } else {
      note = null;
    }
    if (note == null) return button;
    final column = Column(
      crossAxisAlignment: fullWidth
          ? CrossAxisAlignment.stretch
          : CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        button,
        const SizedBox(height: Grid.quarter),
        Text(note, style: _small(context)),
      ],
    );
    return runOff
        ? Tooltip(message: runUnavailableHint, child: column)
        : column;
  }
}

/// The line under a sending control: the words it sends when they differ
/// from its label (in full), or why it can't send.
String? _sendNote(MessageSend send) => switch (send) {
  CaptionSend(:final text) => sendsCaption(text),
  BlockedSend() => sendBlockedText(send),
  LabelSend() => null,
};

/// `{action, style?, icon?, fullWidth?}`: the action's label is the text.
class _ButtonView extends StatelessWidget {
  final _NodeProps p;
  const _ButtonView(this.p);

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    final action = scope.action(p.component.props['action']);
    if (action == null) return const SizedBox.shrink();
    final fullWidth = scope.flag(p.component, 'fullWidth', p.scope);
    final button = _ActionButton(
      action: action,
      scope: p.scope,
      style: _styleOf(scope.string(p.component, 'style')),
      icon: scope.string(p.component, 'icon'),
      fullWidth: fullWidth,
    );
    return fullWidth
        ? button
        : Align(
            alignment: AlignmentDirectional.centerStart,
            widthFactor: 1,
            child: button,
          );
  }
}

List<SurfaceAction> _listedActions(_SurfaceContext scope, List<Object?> ids) =>
    [
      for (final item in ids.take(surfaceMaxActions))
        ?scope.action(item is Map ? item['action'] : item),
    ];

/// A "More" menu of actions.
class _ActionMenu extends StatelessWidget {
  final List<SurfaceAction> actions;
  final String title;

  const _ActionMenu({required this.actions, required this.title});

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    return PopupMenuButton<SurfaceAction>(
      tooltip: title,
      onSelected: (action) => scope.perform(
        context,
        action,
        drawn: action.kind == SurfaceActionKind.sendMessage
            ? scope.sendOf(action)
            : null,
      ),
      itemBuilder: (context) => [
        for (final action in actions)
          PopupMenuItem(
            value: action,
            enabled: scope.canTap(action),
            child: _MenuItemLabel(
              action: action,
              note: action.kind == SurfaceActionKind.sendMessage
                  ? _sendNote(scope.sendOf(action))
                  : null,
            ),
          ),
      ],
      // The menu button owns the one tap target and its label.
      child: Container(
        padding: const EdgeInsets.symmetric(
          horizontal: Grid.twelve,
          vertical: Grid.xxs,
        ),
        decoration: BoxDecoration(
          border: Border.all(color: context.colors.outline),
          borderRadius: BorderRadius.circular(Radii.md),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(BuzzIcons.ellipsis, size: 16, color: context.colors.primary),
            const SizedBox(width: Grid.half + Grid.quarter),
            Text(title, style: _body(context, color: context.colors.primary)),
          ],
        ),
      ),
    );
  }
}

/// A menu item's label, with the words it sends or why it can't ([note]).
/// It is built in the menu's own route, outside the card, so it reads
/// nothing from the card's scope.
class _MenuItemLabel extends StatelessWidget {
  final SurfaceAction action;
  final String? note;

  const _MenuItemLabel({required this.action, this.note});

  @override
  Widget build(BuildContext context) {
    final note = this.note;
    final label = Text(
      action.kind == SurfaceActionKind.run
          ? '${action.label} ($runUnavailableText)'
          : action.label,
      style: action.style == SurfaceActionStyle.destructive
          ? TextStyle(color: context.colors.error)
          : null,
    );
    if (note == null) return label;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        label,
        Text(note, style: _small(context)),
      ],
    );
  }
}

/// The first primary action leads; past four, the rest go in More.
class _ActionBarView extends StatelessWidget {
  final _NodeProps p;
  const _ActionBarView(this.p);

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    final listed = _listedActions(
      scope,
      scope.list(p.component, 'actions', p.scope),
    );
    final primary = listed
        .where((action) => action.style == SurfaceActionStyle.primary)
        .firstOrNull;
    final ordered = primary == null
        ? listed
        : [primary, ...listed.where((action) => action.id != primary.id)];
    final shown = ordered.length > 4 ? ordered.take(3).toList() : ordered;
    final more = ordered.length > 4
        ? ordered.skip(3).toList()
        : const <SurfaceAction>[];
    return Wrap(
      spacing: Grid.xxs,
      runSpacing: Grid.xxs,
      alignment: switch (scope.string(p.component, 'align')) {
        'end' => WrapAlignment.end,
        'spaceBetween' => WrapAlignment.spaceBetween,
        _ => WrapAlignment.start,
      },
      children: [
        for (final action in shown)
          _ActionButton(action: action, scope: p.scope),
        if (more.isNotEmpty) _ActionMenu(actions: more, title: 'More'),
      ],
    );
  }
}

class _MenuView extends StatelessWidget {
  final _NodeProps p;
  const _MenuView(this.p);

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    final actions = _listedActions(
      scope,
      scope.list(p.component, 'actions', p.scope),
    );
    if (actions.isEmpty) return const SizedBox.shrink();
    return Align(
      alignment: AlignmentDirectional.centerStart,
      widthFactor: 1,
      child: _ActionMenu(
        actions: actions,
        title: scope.text(p.component, 'label', p.scope, max: 80) ?? 'More',
      ),
    );
  }
}

/// `chips: [{text, label?}]`: a tap sends `text` as the person's message,
/// drawn in full under the chip when it differs from the label.
class _SuggestionChipsView extends StatelessWidget {
  final _NodeProps p;
  const _SuggestionChipsView(this.p);

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    final enabled =
        scope.host.sendMessage != null && acceptsTaps(scope.surface);
    // The index counts the chips drawn, as every client's tap id does.
    final chips = [
      for (final raw
          in scope.list(p.component, 'chips', p.scope).take(surfaceMaxChips))
        ?chipSend(raw, agentName: scope.agentName),
    ];
    return Wrap(
      spacing: Grid.half + Grid.quarter,
      runSpacing: Grid.half + Grid.quarter,
      children: [
        for (final (index, chip) in chips.indexed)
          _Chip(
            label: chip.label,
            send: chip.send,
            onPressed: enabled && chip.send is! BlockedSend
                ? () => scope.sendChip(context, p.component, index, chip.send)
                : null,
          ),
      ],
    );
  }
}

/// One suggestion chip. Words that differ from the label (or don't fit a
/// one-line chip) are drawn in full inside it (79 M1); a chip that can't
/// send says why under it.
class _Chip extends StatelessWidget {
  final String label;
  final MessageSend send;
  final VoidCallback? onPressed;

  const _Chip({required this.label, required this.send, this.onPressed});

  @override
  Widget build(BuildContext context) {
    final words = send;
    if (words is CaptionSend) {
      return _SurfaceButton(
        label: label,
        caption: sendsCaption(words.text),
        onPressed: onPressed,
      );
    }
    final chip = Tooltip(
      message: 'Sends this as your message',
      child: ActionChip(label: Text(label), onPressed: onPressed),
    );
    final line = sendBlockedText(words);
    if (line == null) return chip;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        chip,
        Text(line, style: _small(context)),
      ],
    );
  }
}

/// `{text, action}`: link-styled text that performs the action.
class _LinkView extends StatelessWidget {
  final _NodeProps p;
  const _LinkView(this.p);

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    final label = scope.text(p.component, 'text', p.scope, max: 200);
    final action = scope.action(p.component.props['action']);
    if (action == null) {
      return label == null
          ? const SizedBox.shrink()
          : Text(label, style: _body(context));
    }
    // A Link sends only the words it shows (79 M1).
    final shown = label ?? action.label;
    final shownHidden = hasInvisibleText(
      resolveProp(p.component.props['text'], scope.data, p.scope),
    );
    final enabled = scope.canTap(
      action,
      shown: shown,
      shownHidden: shownHidden,
    );
    return Align(
      alignment: AlignmentDirectional.centerStart,
      widthFactor: 1,
      child: Semantics(
        link: action.kind == SurfaceActionKind.open,
        button: action.kind != SurfaceActionKind.open,
        enabled: enabled,
        child: InkWell(
          onTap: enabled
              ? () => scope.perform(
                  context,
                  action,
                  shown: shown,
                  shownHidden: shownHidden,
                )
              : null,
          child: Text(
            shown,
            style: _body(
              context,
              color: enabled
                  ? context.colors.primary
                  : context.colors.onSurfaceVariant,
            ),
          ),
        ),
      ),
    );
  }
}
