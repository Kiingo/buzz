/// Bindings, `visibleWhen` and children (§3), as the Kiingo renderers read
/// them. Pure: the views ask.
library;

import 'surface_data.dart';
import 'surface_model.dart';
import 'surface_text.dart';

bool _isBindingShape(Map<String, Object?> prop, Set<String> allowed) =>
    prop['path'] is String && prop.keys.every(allowed.contains);

/// `{path}` (alone, or with `template`/`default`) is a binding.
Pointer? bindingOf(Object? prop, Pointer scope) {
  final object = asObject(prop);
  if (object == null ||
      !_isBindingShape(object, const {'path', 'template', 'default'})) {
    return null;
  }
  return resolvePointer(object['path'] as String, scope);
}

/// A prop's value: the bound data (or the binding's default), else the
/// literal.
Object? resolveProp(Object? prop, Object? data, Pointer scope) {
  final object = asObject(prop);
  if (object != null && _isBindingShape(object, const {'path', 'default'})) {
    final pointer = bindingOf(object, scope);
    final value = pointer == null ? null : readAt(data, pointer);
    return value ?? object['default'];
  }
  return prop;
}

/// A prop as plain text: numbers formatted, booleans Yes/No.
String? propText(Object? prop, Object? data, Pointer scope, {int max = 4000}) {
  final value = resolveProp(prop, data, scope);
  if (value is bool) return value ? 'Yes' : 'No';
  return plainText(value, max, lines: true);
}

/// A prop as a number.
num? propNumber(Object? prop, Object? data, Pointer scope) =>
    asNumber(resolveProp(prop, data, scope));

/// A prop that is exactly true.
bool propBool(Object? prop, Object? data, Pointer scope) =>
    resolveProp(prop, data, scope) == true;

/// As the catalog evaluates it: strict equality; empty is null, "", [], {}.
bool isVisible(SurfaceVisibility? visibility, Object? data, Pointer scope) {
  if (visibility == null) return true;
  final pointer = resolvePointer(visibility.path, scope);
  final found = pointer == null
      ? (found: false, value: null)
      : lookupAt(data, pointer);
  final value = found.value;
  final bool holds;
  switch (visibility.test) {
    case VisibilityTest.equals:
      holds = found.found && jsonEqual(value, visibility.equals);
    case VisibilityTest.isIn:
      holds =
          found.found &&
          visibility.values.any((candidate) => jsonEqual(candidate, value));
    case VisibilityTest.notEmpty:
      final empty =
          value == null ||
          value == '' ||
          (value is List && value.isEmpty) ||
          (value is Map && value.isEmpty);
      holds = empty != visibility.wanted;
  }
  return holds != visibility.negated;
}

/// One component at one scope (repeats give each item its own scope).
typedef SurfaceChildRef = ({String componentId, Pointer scope, String key});

/// The stable key of a component at a scope.
String surfaceChildKey(String componentId, Pointer scope) =>
    '$componentId@${formatPointer(scope)}';

SurfaceChildRef _ref(String componentId, Pointer scope) => (
  componentId: componentId,
  scope: scope,
  key: surfaceChildKey(componentId, scope),
);

/// Children of a container prop: ids, one id, or `{template, path}`
/// repeated over an array.
List<SurfaceChildRef> childrenOf(Object? prop, Object? data, Pointer scope) {
  if (prop is List) {
    return [
      for (final id in prop)
        if (id is String) _ref(id, scope),
    ];
  }
  if (prop is String) return [_ref(prop, scope)];
  final object = asObject(prop);
  final template = asString(object?['template']);
  final path = asString(object?['path']);
  if (template == null || path == null) return const [];
  final pointer = resolvePointer(path, scope);
  final items = pointer == null ? null : readAt(data, pointer);
  if (pointer == null || items is! List) return const [];
  return [
    for (
      var index = 0;
      index < items.length && index < surfaceMaxRepeats;
      index++
    )
      _ref(template, appendPointer(pointer, index)),
  ];
}

/// Most component instances drawn for one surface (repeats count each
/// item). A larger surface shows "too big" with its Kiingo link instead.
const surfaceMaxNodes = 2000;

/// The props a component's children can come from: refs, a repeat, or a
/// list of panels/steps whose `child` is.
const _childProps = ['children', 'child', 'entry', 'content'];
const _panelProps = ['items', 'steps'];

/// How many component instances [surface] would draw, counting every
/// panel (shown or not) to depth [surfaceMaxDepth]; stops once past
/// [limit] (so a huge repeat costs at most [limit] steps).
int surfaceNodeCount(Surface surface, {int limit = surfaceMaxNodes}) {
  if (!surface.components.containsKey(surface.root)) return 0;
  var found = 1;
  final pending = <(SurfaceChildRef, int)>[
    ((componentId: surface.root, scope: rootPointer, key: ''), 0),
  ];
  while (pending.isNotEmpty) {
    final (ref, depth) = pending.removeLast();
    if (depth + 1 > surfaceMaxDepth) continue;
    final component = surface.components[ref.componentId]!;
    // False once past the limit.
    bool push(List<SurfaceChildRef> refs) {
      for (final child in refs) {
        if (!surface.components.containsKey(child.componentId)) continue;
        if (++found > limit) return false;
        pending.add((child, depth + 1));
      }
      return true;
    }

    for (final key in _childProps) {
      if (!push(childrenOf(component.props[key], surface.data, ref.scope))) {
        return found;
      }
    }
    for (final key in _panelProps) {
      final panels = resolveProp(component.props[key], surface.data, ref.scope);
      if (panels is! List) continue;
      for (final panel in panels.take(surfaceMaxRepeats)) {
        final refs = childrenOf(
          fieldOf(panel, 'child'),
          surface.data,
          ref.scope,
        );
        if (!push(refs)) return found;
      }
    }
  }
  return found;
}

/// Whether any of [component]'s props, at any depth, is bound under a path
/// holding outside content (§10, 79 S5). Such a component is drawn as a
/// quote, with no links or actions.
bool readsUntrusted(
  Surface surface,
  SurfaceComponent component,
  Pointer scope,
) {
  if (surface.untrustedPaths.isEmpty) return false;
  var budget = 2000;
  bool visit(Object? value) {
    if (--budget < 0) return true;
    if (value is Map) {
      final path = value['path'];
      if (path is String) {
        final pointer = resolvePointer(path, scope);
        if (pointer != null && isUntrustedPath(surface, pointer)) return true;
      }
      return value.values.any(visit);
    }
    if (value is List) return value.any(visit);
    return false;
  }

  return component.props.values.any(visit) ||
      (scope.isNotEmpty && isUntrustedPath(surface, scope));
}
