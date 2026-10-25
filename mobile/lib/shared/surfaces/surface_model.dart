/// The wire model of an agent surface (`kiingo.ui/v1`), decoded leniently
/// like the Kiingo renderers: a component type this version doesn't know is
/// kept and drawn as "needs a newer app", never a failure. Everything an
/// agent wrote is plain text to a renderer; colours never come from the
/// agent.
library;

import 'package:flutter/foundation.dart';

import 'surface_data.dart';
import 'surface_text.dart';

/// The catalog this version draws.
const surfaceCatalogV1 = 'kiingo.ui/v1';

/// Most components read from one surface.
const surfaceMaxComponents = 200;

/// Deepest nesting drawn.
const surfaceMaxDepth = 12;

/// Most actions read from one surface.
const surfaceMaxActions = 20;

/// At most this many repeats are drawn.
const surfaceMaxRepeats = 500;

/// How the agent asked the surface to show.
enum SurfaceDisplay { inline, expanded, carousel }

/// The server's lifecycle state.
enum SurfaceState { active, submitted, dismissed, closed, other }

/// Who made the last change.
enum SurfaceActorKind { user, agent, hostApp, member, system }

/// Every component this version draws.
const surfaceComponentTypes = {
  // Layout
  'Stack', 'Grid', 'Section', 'Card', 'Tabs', 'Accordion', 'Carousel',
  'Steps', 'Divider', 'Modal',
  // Display
  'Text', 'Markdown', 'Image', 'ImageGallery', 'Icon', 'Badge', 'Avatar',
  'KeyValue', 'Table', 'List', 'Chart', 'Metric', 'Progress', 'Timeline',
  'Code', 'Diff', 'Callout', 'Quote', 'EntityRef', 'FileList', 'Media',
  'LinkPreview', 'Map', 'Countdown',
  // Inputs
  'TextField', 'RichTextEditor', 'RecipientField', 'Select', 'ChoicePicker',
  'Checkbox', 'Toggle', 'Slider', 'Stepper', 'DateTimeInput', 'Rating',
  'FileInput', 'EntityPicker', 'Reorder', 'TimeSlotPicker',
  // Actions
  'Button', 'ActionBar', 'SuggestionChips', 'Menu', 'Link',
};

/// The input components.
const surfaceInputTypes = {
  'TextField',
  'RichTextEditor',
  'RecipientField',
  'Select',
  'ChoicePicker',
  'Checkbox',
  'Toggle',
  'Slider',
  'Stepper',
  'DateTimeInput',
  'Rating',
  'FileInput',
  'EntityPicker',
  'Reorder',
  'TimeSlotPicker',
};

/// How `visibleWhen` tests its value.
enum VisibilityTest { equals, notEmpty, isIn }

/// `visibleWhen: {path, equals | notEmpty | in, not?}`.
@immutable
class SurfaceVisibility {
  final String path;
  final VisibilityTest test;
  final Object? equals;
  final bool wanted;
  final List<Object?> values;
  final bool negated;

  const SurfaceVisibility({
    required this.path,
    required this.test,
    this.equals,
    this.wanted = true,
    this.values = const [],
    this.negated = false,
  });
}

/// One component of a surface.
@immutable
class SurfaceComponent {
  final String id;

  /// The wire type, kept even when unknown.
  final String type;
  final bool known;
  final Map<String, Object?> props;
  final SurfaceVisibility? visibleWhen;

  const SurfaceComponent({
    required this.id,
    required this.type,
    required this.known,
    required this.props,
    this.visibleWhen,
  });
}

/// Kiingo object types an EntityRef may name.
const surfaceEntityTypes = [
  'task',
  'project',
  'person',
  'agent',
  'email_thread',
  'file',
  'calendar_event',
  'deal',
  'company',
];

/// A Kiingo object.
@immutable
class SurfaceEntity {
  final String type;
  final String id;
  final String? title;

  const SurfaceEntity({required this.type, required this.id, this.title});
}

/// What an action does.
enum SurfaceActionKind {
  run,
  askAgent,
  sendMessage,
  setState,
  open,
  dismiss,
  unknown,
}

/// How an action button looks.
enum SurfaceActionStyle { primary, secondary, destructive, plain }

/// Where an `open` action goes.
sealed class SurfaceOpenTarget {
  const SurfaceOpenTarget();
}

class SurfaceOpenUrl extends SurfaceOpenTarget {
  final String url;
  const SurfaceOpenUrl(this.url);
}

class SurfaceOpenEntity extends SurfaceOpenTarget {
  final SurfaceEntity entity;
  const SurfaceOpenEntity(this.entity);
}

class SurfaceOpenExpanded extends SurfaceOpenTarget {
  const SurfaceOpenExpanded();
}

/// One action. Labels are plain text; a `run` is never confirmed from them.
@immutable
class SurfaceAction {
  final String id;
  final SurfaceActionKind kind;
  final String label;
  final SurfaceActionStyle style;
  final String? icon;

  /// send_message: the words sent as the person's message (else the label).
  final String? text;
  final SurfaceOpenTarget? target;

  /// The agent's raw label or words held a character that draws nothing
  /// (S1): this action never sends.
  final bool hidden;

  const SurfaceAction({
    required this.id,
    required this.kind,
    required this.label,
    required this.style,
    this.icon,
    this.text,
    this.target,
    this.hidden = false,
  });
}

/// The status tone the server sets.
enum SurfaceStatusTone { info, success, warning, danger }

/// The server's status line.
@immutable
class SurfaceStatus {
  final String text;
  final SurfaceStatusTone tone;

  const SurfaceStatus({required this.text, required this.tone});
}

/// The last change's author.
@immutable
class SurfaceLastEdit {
  final SurfaceActorKind? actorKind;
  final String? client;

  const SurfaceLastEdit({this.actorKind, this.client});
}

/// A decoded surface.
@immutable
class Surface {
  final String id;
  final String catalog;
  final String title;
  final SurfaceDisplay display;
  final String root;
  final Map<String, SurfaceComponent> components;

  /// The server's order (for unknown-type reporting).
  final List<String> order;
  final Map<String, Object?> data;

  /// Paths holding outside content (`external_untrusted`, §10).
  final List<Pointer> untrustedPaths;
  final Map<String, SurfaceAction> actions;
  final int revision;
  final SurfaceState state;

  /// The agent named in the header ("from Dana").
  final String? agentName;

  /// The agent's Buzz key (lowercase hex) when the host names it; a card
  /// drawn under another signer's message is not drawn (79).
  final String? agentPubkey;
  final bool editorsAudience;
  final bool repeatable;

  /// The server's rights for this viewer. Display only.
  final bool viewerCanEdit;
  final bool viewerCanAct;
  final SurfaceLastEdit? lastEdit;
  final SurfaceStatus? status;

  /// The surface's page in Kiingo (https only).
  final String? webUrl;

  const Surface({
    required this.id,
    required this.catalog,
    required this.title,
    required this.display,
    required this.root,
    required this.components,
    required this.order,
    required this.data,
    required this.untrustedPaths,
    required this.actions,
    required this.revision,
    required this.state,
    this.agentName,
    this.agentPubkey,
    required this.editorsAudience,
    required this.repeatable,
    required this.viewerCanEdit,
    required this.viewerCanAct,
    this.lastEdit,
    this.status,
    this.webUrl,
  });
}

SurfaceState _stateOf(String? raw) => switch ((raw ?? '').toLowerCase()) {
  '' || 'active' || 'open' => SurfaceState.active,
  'submitted' => SurfaceState.submitted,
  'dismissed' => SurfaceState.dismissed,
  'closed' => SurfaceState.closed,
  _ => SurfaceState.other,
};

/// `visibleWhen`, or null when it has no path.
SurfaceVisibility? decodeVisibility(Object? value) {
  final object = asObject(value);
  final path = asString(object?['path']);
  if (object == null || path == null) return null;
  final negated = object['not'] == true;
  if (object.containsKey('equals')) {
    return SurfaceVisibility(
      path: path,
      test: VisibilityTest.equals,
      equals: object['equals'],
      negated: negated,
    );
  }
  final values = object['in'];
  if (values is List) {
    return SurfaceVisibility(
      path: path,
      test: VisibilityTest.isIn,
      values: List.unmodifiable(values),
      negated: negated,
    );
  }
  return SurfaceVisibility(
    path: path,
    test: VisibilityTest.notEmpty,
    wanted: asBool(object['notEmpty']) ?? true,
    negated: negated,
  );
}

SurfaceComponent? _decodeComponent(Object? value) {
  final id = plainId(fieldOf(value, 'id'));
  final type = asString(fieldOf(value, 'type'));
  if (id == null || type == null || type.isEmpty || type.length > 64) {
    return null;
  }
  final props = <String, Object?>{...?asObject(fieldOf(value, 'props'))};
  final visibleWhen = decodeVisibility(
    fieldOf(value, 'visibleWhen') ?? props['visibleWhen'],
  );
  props.remove('visibleWhen');
  return SurfaceComponent(
    id: id,
    type: type,
    known: surfaceComponentTypes.contains(type),
    props: Map.unmodifiable(props),
    visibleWhen: visibleWhen,
  );
}

/// An entity key `{type, id, title?}`, or null.
SurfaceEntity? decodeEntity(Object? value) {
  final raw = asString(fieldOf(value, 'type') ?? fieldOf(value, 'entityType'));
  final type = raw?.replaceAll('-', '_');
  final id = plainId(fieldOf(value, 'id') ?? fieldOf(value, 'entityId'));
  if (type == null || !surfaceEntityTypes.contains(type) || id == null) {
    return null;
  }
  final title = plainText(
    fieldOf(value, 'title') ?? fieldOf(value, 'label'),
    200,
  );
  return SurfaceEntity(type: type, id: id, title: title);
}

const _actionKinds = {
  'run': SurfaceActionKind.run,
  'ask_agent': SurfaceActionKind.askAgent,
  'send_message': SurfaceActionKind.sendMessage,
  'set_state': SurfaceActionKind.setState,
  'open': SurfaceActionKind.open,
  'dismiss': SurfaceActionKind.dismiss,
};

const _actionStyles = {
  'primary': SurfaceActionStyle.primary,
  'secondary': SurfaceActionStyle.secondary,
  'destructive': SurfaceActionStyle.destructive,
  'plain': SurfaceActionStyle.plain,
};

String _defaultLabel(SurfaceActionKind kind) => switch (kind) {
  SurfaceActionKind.run => 'Run',
  SurfaceActionKind.askAgent => 'Ask agent',
  SurfaceActionKind.sendMessage => 'Send',
  SurfaceActionKind.setState => 'Change',
  SurfaceActionKind.open => 'Open',
  SurfaceActionKind.dismiss => 'Dismiss',
  SurfaceActionKind.unknown => 'Action',
};

/// One action from `actions[id]`, or null.
SurfaceAction? decodeAction(String id, Object? value) {
  final object = asObject(value);
  final rawKind = asString(object?['kind']);
  if (plainId(id) == null || object == null || rawKind == null) return null;
  final kind = _actionKinds[rawKind] ?? SurfaceActionKind.unknown;
  SurfaceOpenTarget? target;
  final rawTarget = asObject(object['target']);
  if (rawTarget != null) {
    final url = openableUrl(rawTarget['url']);
    final entity = decodeEntity(rawTarget['entity']);
    if (url != null) {
      target = SurfaceOpenUrl(url);
    } else if (entity != null) {
      target = SurfaceOpenEntity(entity);
    } else if (rawTarget['expanded'] == true) {
      target = const SurfaceOpenExpanded();
    }
  }
  return SurfaceAction(
    id: id,
    kind: kind,
    label: plainText(object['label'], 200) ?? _defaultLabel(kind),
    style:
        _actionStyles[asString(object['style'])] ??
        SurfaceActionStyle.secondary,
    icon: plainText(object['icon'], 64),
    text: plainText(object['text'], 2000, lines: true),
    target: target,
    hidden:
        hasInvisibleText(object['label']) || hasInvisibleText(object['text']),
  );
}

const _statusTones = {
  'info': SurfaceStatusTone.info,
  'success': SurfaceStatusTone.success,
  'warning': SurfaceStatusTone.warning,
  'danger': SurfaceStatusTone.danger,
};

const _actorKinds = {
  'user': SurfaceActorKind.user,
  'agent': SurfaceActorKind.agent,
  'host_app': SurfaceActorKind.hostApp,
  'member': SurfaceActorKind.member,
  'system': SurfaceActorKind.system,
};

String? _httpsUrl(Object? raw) {
  final url = openableUrl(raw);
  return url != null && url.startsWith('https://') ? url : null;
}

/// `{surface: {...}}`, `{data: {surface}}` or the surface itself. Null when
/// it isn't a surface (no id or no root).
Surface? decodeSurface(Object? value) {
  final object = asObject(value);
  if (object == null) return null;
  final nested = asObject(object['surface']);
  if (nested != null) return decodeSurface(nested);
  final inData = asObject(fieldOf(object['data'], 'surface'));
  if (inData != null) return decodeSurface(inData);
  final spec = asObject(object['spec']);
  Object? get(String key) => object[key] ?? spec?[key];
  final id = plainId(object['surfaceId'] ?? object['id']);
  if (id == null) return null;
  final list = get('components');
  final decoded = <SurfaceComponent>[
    if (list is List)
      for (final item in list.take(surfaceMaxComponents))
        ?_decodeComponent(item),
  ];
  final root =
      plainId(get('root')) ?? (decoded.isEmpty ? null : decoded.first.id);
  if (root == null) return null;
  final byId = <String, SurfaceComponent>{};
  for (final component in decoded) {
    byId.putIfAbsent(component.id, () => component);
  }
  final actions = <String, SurfaceAction>{};
  final rawActions = asObject(get('actions'));
  if (rawActions != null) {
    for (final entry in rawActions.entries.take(surfaceMaxActions)) {
      final action = decodeAction(entry.key, entry.value);
      if (action != null) actions[entry.key] = action;
    }
  }
  final untrusted = <Pointer>[];
  final trust = asObject(get('dataTrust'));
  if (trust != null) {
    for (final entry in trust.entries) {
      final pointer = parsePointer(entry.key);
      if (entry.value == 'external_untrusted' && pointer != null) {
        untrusted.add(pointer);
      }
    }
  }
  final agent = object['agent'];
  final viewer = asObject(object['viewer']);
  final edit = asObject(object['lastEdit']);
  final display = asString(get('display'));
  final rawStatus = asObject(object['status']);
  final statusText = plainText(rawStatus?['text'], 500);
  final repeatableFlag = asBool(get('repeatable'));
  return Surface(
    id: id,
    catalog: asString(get('catalog')) ?? surfaceCatalogV1,
    title: plainText(get('title'), 200) ?? '',
    display: display == 'expanded'
        ? SurfaceDisplay.expanded
        : display == 'carousel'
        ? SurfaceDisplay.carousel
        : SurfaceDisplay.inline,
    root: root,
    components: Map.unmodifiable(byId),
    order: List.unmodifiable(decoded.map((component) => component.id)),
    data: asObject(get('data')) ?? const {},
    untrustedPaths: List.unmodifiable(untrusted),
    actions: Map.unmodifiable(actions),
    revision: asInt(object['revision'] ?? object['currentRevision']) ?? 1,
    state: _stateOf(asString(object['state'])),
    agentName: plainText(
      object['agentName'] ??
          fieldOf(agent, 'name') ??
          fieldOf(agent, 'displayName'),
      80,
    ),
    agentPubkey: _agentPubkeyOf(agent),
    editorsAudience: asString(get('editors')) == 'audience',
    repeatable:
        repeatableFlag ??
        (rawActions?.values.any(
              (raw) =>
                  fieldOf(raw, 'kind') == 'run' &&
                  fieldOf(raw, 'repeatable') == true,
            ) ??
            false),
    // No viewer block: nothing may be edited or tapped (the server decides).
    viewerCanEdit: viewer?['canEdit'] == true,
    viewerCanAct: viewer?['canAct'] == true,
    lastEdit: edit == null
        ? null
        : SurfaceLastEdit(
            actorKind: _actorKinds[asString(edit['actorKind'])],
            client: asString(edit['client']),
          ),
    status: statusText == null
        ? null
        : SurfaceStatus(
            text: statusText,
            tone:
                _statusTones[asString(rawStatus?['tone'])] ??
                SurfaceStatusTone.info,
          ),
    webUrl: _httpsUrl(object['webUrl']),
  );
}

// --- Rules on a decoded surface ----------------------------------------------

/// Whether this version knows the surface's catalog.
bool isKnownCatalog(Surface surface) => surface.catalog == surfaceCatalogV1;

/// Dismissed or closed.
bool isOver(Surface surface) =>
    surface.state == SurfaceState.dismissed ||
    surface.state == SurfaceState.closed;

bool _isOpen(Surface surface) =>
    surface.state == SurfaceState.active ||
    (surface.state == SurfaceState.submitted && surface.repeatable);

/// Open, and the server says this viewer may edit.
bool acceptsEdits(Surface surface) => surface.viewerCanEdit && _isOpen(surface);

/// Open, and the server says this viewer may act.
bool acceptsTaps(Surface surface) => surface.viewerCanAct && _isOpen(surface);

/// Component types this version can't draw.
List<String> unknownTypes(Surface surface) {
  final seen = <String>[];
  for (final id in surface.order) {
    final component = surface.components[id];
    if (component != null &&
        !component.known &&
        !seen.contains(component.type)) {
      seen.add(component.type);
    }
  }
  return seen;
}

final _hexKey = RegExp(r'^[0-9a-f]{64}$');

/// `agent.pubkey` (or `agent.buzzPubkey`) as lowercase hex, else null.
String? _agentPubkeyOf(Object? agent) {
  final raw = fieldOf(agent, 'pubkey') ?? fieldOf(agent, 'buzzPubkey');
  if (raw is! String) return null;
  final key = raw.trim().toLowerCase();
  return _hexKey.hasMatch(key) ? key : null;
}

/// Whether [pointer] holds outside content (it or a parent is marked).
bool isUntrustedPath(Surface surface, Pointer pointer) =>
    surface.untrustedPaths.any((marked) => isPointerPrefix(marked, pointer));

/// Whether a binding to [pointer] can read outside content (79 S5): a
/// marked pointer is at, under or above it. Binding `/replies` reads the
/// marked `/replies/0` too.
bool touchesUntrustedPath(Surface surface, Pointer pointer) =>
    surface.untrustedPaths.any(
      (marked) =>
          isPointerPrefix(marked, pointer) || isPointerPrefix(pointer, marked),
    );

const _clientLabels = {
  'companion_mac': 'Mac',
  'tasks_ios': 'iPhone',
  'dashboard': 'the dashboard',
  'buzz': 'Buzz',
  'teams': 'Teams',
  'mcp_app': 'another app',
};

/// "Edited on Mac" when the last change came from another of the person's
/// clients; "Changed by" the agent ([agentName], from the signer's
/// profile) when the agent changed it.
String? editedNote(
  Surface surface, {
  String ownClient = 'buzz',
  String? agentName,
}) {
  final edit = surface.lastEdit;
  if (edit == null) return null;
  switch (edit.actorKind) {
    case SurfaceActorKind.user:
      final label = _clientLabels[edit.client];
      return edit.client != ownClient && label != null
          ? 'Edited on $label'
          : null;
    case SurfaceActorKind.agent:
      return 'Changed by ${agentName ?? 'the agent'}';
    case SurfaceActorKind.hostApp:
      return 'Changed in another app';
    case SurfaceActorKind.member:
      return 'Changed by someone else here';
    case SurfaceActorKind.system:
    case null:
      return null;
  }
}

/// Shown on a run button wherever direct actions aren't available.
const runUnavailableText = 'Open in the Kiingo app';

/// The run button's longer hint.
const runUnavailableHint =
    'Buttons that send or change things work in the Kiingo app on your '
    'iPhone or Mac.';

/// This client shows surfaces view only: changes happen in Kiingo.
const viewOnlyHint = 'View only here. Open it in Kiingo to make changes.';
