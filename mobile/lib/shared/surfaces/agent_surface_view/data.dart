part of '../agent_surface_view.dart';

// §4.2 Table and List. Sorting, filtering and paging are on screen only;
// selections and cell edits happen in Kiingo.

typedef _Column = ({
  int index,
  String key,
  String title,
  String type,
  bool trailing,
  String? currency,
  String? width,
});

List<_Column> _columnsOf(List<Object?> raw) => [
  for (final (index, item) in raw.take(12).indexed)
    if (asObject(item) case final column?)
      if (asString(column['key']) case final key?)
        (
          index: index,
          key: key,
          // The key too is the agent's text (79).
          title: plainText(column['title'], 60) ?? plainText(key, 60) ?? '',
          type: asString(column['type']) ?? 'text',
          trailing: switch (asString(column['align'])) {
            'end' || 'right' => true,
            null => column['type'] == 'number' || column['type'] == 'currency',
            _ => false,
          },
          currency: asString(column['currency']),
          width: asString(column['width']),
        ),
];

int _compareCells(Object? a, Object? b) {
  final x = asNumber(a);
  final y = asNumber(b);
  if (x != null && y != null) return x.compareTo(y);
  return cellText(a).toLowerCase().compareTo(cellText(b).toLowerCase());
}

class _TableView extends HookWidget {
  final _NodeProps p;
  const _TableView(this.p);

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    final sortKey = useState<String?>(null);
    final ascending = useState(true);
    final filter = useState('');
    final pages = useState(1);
    final columns = _columnsOf(scope.list(p.component, 'columns', p.scope));
    final all = scope.list(p.component, 'rows', p.scope);
    final sortable = scope.flag(p.component, 'sortable', p.scope);
    final filterable = scope.flag(p.component, 'filterable', p.scope);
    final pageSize = (scope.number(p.component, 'pageSize', p.scope) ?? 50)
        .round()
        .clamp(1, 200);
    final selectable = scope.string(p.component, 'selectable') ?? 'none';
    final selectionPointer = bindingOf(p.component.props['selection'], p.scope);
    final selection = selectionPointer == null
        ? null
        : readAt(scope.data, selectionPointer);
    final selected = {
      if (selection is List)
        for (final item in selection) ?asInt(item),
    };
    var shown = [
      for (final (index, row) in all.indexed) (index: index, row: row),
    ];
    final needle = filter.value.trim().toLowerCase();
    if (needle.isNotEmpty) {
      shown = [
        for (final entry in shown)
          if (columns.any(
            (column) => cellText(
              fieldOf(entry.row, column.key),
            ).toLowerCase().contains(needle),
          ))
            entry,
      ];
    }
    final key = sortKey.value;
    if (key != null) {
      shown.sort((a, b) {
        final order = _compareCells(fieldOf(a.row, key), fieldOf(b.row, key));
        return ascending.value ? order : -order;
      });
    }
    final limit = pageSize * pages.value;
    final empty = scope.text(p.component, 'emptyText', p.scope, max: 200);
    final colors = context.colors;
    final headerStyle = _small(context).copyWith(fontWeight: FontWeight.w600);
    Widget header(_Column column) {
      final label = Text(column.title, style: headerStyle);
      if (!sortable) return label;
      final active = key == column.key;
      return Semantics(
        button: true,
        hint: active
            ? (ascending.value ? 'Sorted ascending' : 'Sorted descending')
            : 'Sort',
        child: InkWell(
          onTap: () {
            if (active) {
              ascending.value = !ascending.value;
            } else {
              sortKey.value = column.key;
              ascending.value = true;
            }
          },
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Flexible(child: label),
              if (active)
                Icon(
                  ascending.value ? BuzzIcons.chevronUp : BuzzIcons.chevronDown,
                  size: 12,
                  color: colors.onSurfaceVariant,
                ),
            ],
          ),
        ),
      );
    }

    Widget cell(_Column column, Object? row) {
      final value = fieldOf(row, column.key);
      final number = asNumber(value);
      final Widget content = switch (column.type) {
        'number' => Text(
          number != null ? formatSurfaceNumber(number) : cellText(value),
          style: _body(context),
        ),
        'currency' => Text(
          number != null
              ? formatSurfaceCurrency(number, column.currency ?? 'USD')
              : cellText(value),
          style: _body(context),
        ),
        'date' => Text(formatSurfaceDate(value) ?? '', style: _body(context)),
        'badge' => switch (plainText(value, 40)) {
          final text? => _Badge(text: text),
          null => const SizedBox.shrink(),
        },
        'link' => switch (openableUrl(fieldOf(value, 'url') ?? value)) {
          final link? => InkWell(
            onTap: () => scope.openLink(context, link),
            child: Text(
              plainText(fieldOf(value, 'title'), 120) ?? urlHost(link),
              style: _body(context, color: colors.primary),
            ),
          ),
          null => Text(cellText(value), style: _body(context)),
        },
        'entity' => switch (decodeEntity(value)) {
          final entity? => _EntityChip(entity: entity),
          null => Text(cellText(value), style: _body(context)),
        },
        _ => Text(
          cellText(value),
          maxLines: 3,
          overflow: TextOverflow.ellipsis,
          style: _body(context),
        ),
      };
      return ConstrainedBox(
        constraints: BoxConstraints(
          minWidth: column.width == 'wide' ? 256 : 0,
          maxWidth: column.width == 'narrow' ? 80 : 320,
        ),
        child: Align(
          alignment: column.trailing
              ? AlignmentDirectional.centerEnd
              : AlignmentDirectional.centerStart,
          widthFactor: 1,
          child: content,
        ),
      );
    }

    const cellPadding = EdgeInsets.symmetric(
      horizontal: Grid.twelve,
      vertical: Grid.half + Grid.quarter,
    );
    return _Gapped(
      children: [
        if (all.isEmpty && empty != null) Text(empty, style: _small(context)),
        if (filterable)
          TextField(
            onChanged: (text) {
              filter.value = text;
              pages.value = 1;
            },
            style: _small(context, color: colors.onSurface),
            decoration: const InputDecoration(
              isDense: true,
              hintText: 'Filter',
              border: OutlineInputBorder(),
            ),
            textInputAction: TextInputAction.search,
          ),
        if (all.isNotEmpty)
          Container(
            decoration: BoxDecoration(
              border: Border.all(color: colors.outlineVariant),
              borderRadius: BorderRadius.circular(Radii.md),
            ),
            clipBehavior: Clip.antiAlias,
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Table(
                defaultColumnWidth: const IntrinsicColumnWidth(),
                defaultVerticalAlignment: TableCellVerticalAlignment.top,
                children: [
                  TableRow(
                    decoration: BoxDecoration(
                      color: colors.surfaceContainerHighest.withValues(
                        alpha: 0.5,
                      ),
                    ),
                    children: [
                      if (selectable != 'none')
                        Padding(
                          padding: cellPadding,
                          child: Semantics(
                            label: 'Selected',
                            child: SizedBox(width: 16),
                          ),
                        ),
                      for (final column in columns)
                        Padding(padding: cellPadding, child: header(column)),
                    ],
                  ),
                  for (final entry in shown.take(limit))
                    TableRow(
                      decoration: BoxDecoration(
                        color: selected.contains(entry.index)
                            ? colors.primary.withValues(alpha: 0.05)
                            : null,
                        border: Border(
                          top: BorderSide(color: colors.outlineVariant),
                        ),
                      ),
                      children: [
                        if (selectable != 'none')
                          Padding(
                            padding: cellPadding,
                            child: Icon(
                              selected.contains(entry.index)
                                  ? BuzzIcons.circleCheck
                                  : BuzzIcons.circle,
                              size: 16,
                              color: colors.onSurfaceVariant,
                              semanticLabel: selected.contains(entry.index)
                                  ? 'Selected'
                                  : 'Not selected',
                            ),
                          ),
                        for (final column in columns)
                          Padding(
                            padding: cellPadding,
                            child: cell(column, entry.row),
                          ),
                      ],
                    ),
                ],
              ),
            ),
          ),
        if (shown.length > limit)
          Align(
            alignment: AlignmentDirectional.centerStart,
            child: _SurfaceButton(
              label: 'Show ${math.min(pageSize, shown.length - limit)} more',
              style: SurfaceActionStyle.plain,
              onPressed: () => pages.value = pages.value + 1,
            ),
          ),
      ],
    );
  }
}

/// `items: {path}`; title, subtitle, trailing and badge are read per item
/// (usually item-relative, `./title`). A tap runs `onTap` where it works
/// here.
class _ListView extends StatelessWidget {
  final _NodeProps p;
  const _ListView(this.p);

  @override
  Widget build(BuildContext context) {
    final scope = _SurfaceScope.of(context);
    final pointer = bindingOf(p.component.props['items'], p.scope);
    final items = pointer == null ? null : readAt(scope.data, pointer);
    final count = items is List ? math.min(items.length, surfaceMaxRepeats) : 0;
    final empty = scope.text(p.component, 'emptyText', p.scope, max: 200);
    final action = scope.action(p.component.props['onTap']);
    // A row tap never sends a message (79 M1): its words aren't shown.
    final tappable = action != null && scope.canTap(action, sends: false);
    final selectionPointer = bindingOf(p.component.props['selection'], p.scope);
    final selected = selectionPointer == null
        ? null
        : asInt(readAt(scope.data, selectionPointer));
    final leading = asObject(p.component.props['leading']);
    final badge = asObject(p.component.props['badge']);
    final colors = context.colors;
    if (pointer == null || count == 0) {
      return empty == null
          ? const SizedBox.shrink()
          : Text(empty, style: _small(context));
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        for (var index = 0; index < count; index++) ...[
          if (index > 0) Divider(height: 1, color: colors.outlineVariant),
          Builder(
            builder: (context) {
              final itemScope = appendPointer(pointer, index);
              final subtitle = scope.textOf(
                p.component.props['subtitle'],
                itemScope,
                max: 300,
              );
              final trailing = scope.textOf(
                p.component.props['trailing'],
                itemScope,
                max: 60,
              );
              final badgeText = badge == null
                  ? null
                  : scope.textOf(badge['text'], itemScope, max: 40);
              final row = Container(
                color: selected == index
                    ? colors.primary.withValues(alpha: 0.05)
                    : null,
                padding: const EdgeInsets.symmetric(vertical: Grid.xxs),
                child: Row(
                  children: [
                    if (leading != null) ...[
                      _Leading(leading: leading, scope: itemScope),
                      const SizedBox(width: Grid.xxs + Grid.quarter),
                    ],
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            scope.textOf(
                                  p.component.props['title'],
                                  itemScope,
                                  max: 200,
                                ) ??
                                '',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: _body(context),
                          ),
                          if (subtitle != null)
                            Text(
                              subtitle,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: _small(context),
                            ),
                        ],
                      ),
                    ),
                    if (badgeText != null) ...[
                      const SizedBox(width: Grid.xxs),
                      _Badge(text: badgeText, tone: asString(badge?['tone'])),
                    ],
                    if (trailing != null) ...[
                      const SizedBox(width: Grid.xxs),
                      Text(trailing, style: _small(context)),
                    ],
                  ],
                ),
              );
              return MergeSemantics(
                child: Semantics(
                  selected: selected == index,
                  button: tappable,
                  child: tappable
                      ? InkWell(
                          onTap: () =>
                              scope.perform(context, action, sends: false),
                          child: row,
                        )
                      : row,
                ),
              );
            },
          ),
        ],
      ],
    );
  }
}

class _Leading extends StatelessWidget {
  final Map<String, Object?> leading;
  final Pointer scope;
  const _Leading({required this.leading, required this.scope});

  @override
  Widget build(BuildContext context) {
    final surface = _SurfaceScope.of(context);
    final image = surface.textOf(leading['imageUrl'], scope, max: 2048);
    if (image != null) {
      return ClipOval(
        child: SizedBox(
          width: 28,
          height: 28,
          child: _ProxyImage(url: image, alt: '', cover: true, aspect: 1),
        ),
      );
    }
    final initials = surface.textOf(leading['initials'], scope, max: 3);
    if (initials != null) {
      return ExcludeSemantics(
        child: CircleAvatar(
          radius: 14,
          backgroundColor: context.colors.surfaceContainerHighest,
          child: Text(
            initials,
            style: context.textTheme.labelSmall?.copyWith(
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
      );
    }
    final icon = asString(leading['icon']);
    if (icon != null) {
      return Icon(
        _catalogIcon(icon),
        size: 16,
        color: context.colors.onSurfaceVariant,
      );
    }
    return const SizedBox.shrink();
  }
}
