/// JSON values and JSON Pointers (RFC 6901) for agent surfaces
/// (`kiingo.ui/v1`), as the Kiingo surface renderers read them. Values are
/// what `jsonDecode` returns: maps, lists, strings, numbers, booleans and
/// null.
library;

/// A JSON object, or null when [value] is anything else.
Map<String, Object?>? asObject(Object? value) =>
    value is Map<String, Object?> ? value : null;

/// `value[key]` for objects, else null.
Object? fieldOf(Object? value, String key) => asObject(value)?[key];

/// [value] when it is a string.
String? asString(Object? value) => value is String ? value : null;

/// A finite number, or a string that reads as one.
num? asNumber(Object? value) {
  if (value is num) return value.isFinite ? value : null;
  if (value is String && value.trim().isNotEmpty) {
    final parsed = num.tryParse(value.trim());
    return parsed != null && parsed.isFinite ? parsed : null;
  }
  return null;
}

/// [asNumber] truncated to a whole number.
int? asInt(Object? value) => asNumber(value)?.truncate();

/// [value] when it is a boolean.
bool? asBool(Object? value) => value is bool ? value : null;

/// Deep equality for JSON values (1 and 1.0 are equal).
bool jsonEqual(Object? a, Object? b) {
  if (a is num && b is num) return a == b;
  if (a is List && b is List) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (!jsonEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (a is Map && b is Map) {
    if (a.length != b.length) return false;
    for (final key in a.keys) {
      if (!b.containsKey(key) || !jsonEqual(a[key], b[key])) return false;
    }
    return true;
  }
  return a == b;
}

/// Empty for required checks: null, "" (after trimming), [], {}, false, and
/// rich text `{format: "markdown", text: ""}`.
bool isEmptyValue(Object? value) {
  if (value == null || value == false) return true;
  if (value is String) return value.trim().isEmpty;
  if (value is List) return value.isEmpty;
  if (value is Map) {
    if (value['format'] == 'markdown' && value['text'] is String) {
      return (value['text'] as String).trim().isEmpty;
    }
    return value.isEmpty;
  }
  return false;
}

/// A JSON Pointer as its unescaped tokens. Inside a repeated child a relative
/// path (`.` or `./a`) joins the item's pointer (its scope).
typedef Pointer = List<String>;

/// The root pointer.
const Pointer rootPointer = [];

const _maxPointerLength = 512;
const _maxTokens = 32;

/// `"/a/b~1c"` → `["a", "b/c"]`; `""` is the root. Null when malformed.
Pointer? parsePointer(String raw) {
  if (raw.isEmpty) return rootPointer;
  if (!raw.startsWith('/') || raw.length > _maxPointerLength) return null;
  final parts = raw.substring(1).split('/');
  if (parts.length > _maxTokens) return null;
  return [
    for (final part in parts) part.replaceAll('~1', '/').replaceAll('~0', '~'),
  ];
}

/// A binding path read in [scope]: absolute stays, relative joins.
Pointer? resolvePointer(String raw, Pointer scope) {
  if (raw.isEmpty || raw.startsWith('/')) return parsePointer(raw);
  if (scope.isEmpty) return null;
  if (raw == '.') return scope;
  final tail = parsePointer(
    '/${raw.startsWith('./') ? raw.substring(2) : raw}',
  );
  return tail == null ? null : [...scope, ...tail];
}

/// The pointer as its JSON Pointer text.
String formatPointer(Pointer pointer) => pointer
    .map((token) => '/${token.replaceAll('~', '~0').replaceAll('/', '~1')}')
    .join();

/// [pointer] with one more token.
Pointer appendPointer(Pointer pointer, Object token) => [...pointer, '$token'];

/// Whether [prefix] is [of] or one of its parents.
bool isPointerPrefix(Pointer prefix, Pointer of) {
  if (of.length < prefix.length) return false;
  for (var i = 0; i < prefix.length; i++) {
    if (of[i] != prefix[i]) return false;
  }
  return true;
}

final _arrayIndex = RegExp(r'^(?:0|[1-9][0-9]*)$');

/// What [pointer] finds in [data]: `found` is false when any step is missing
/// (a present null is found).
({bool found, Object? value}) lookupAt(Object? data, Pointer pointer) {
  Object? current = data;
  for (final token in pointer) {
    if (current is List) {
      if (!_arrayIndex.hasMatch(token)) return (found: false, value: null);
      final index = int.tryParse(token);
      if (index == null || index >= current.length) {
        return (found: false, value: null);
      }
      current = current[index];
    } else if (current is Map) {
      if (!current.containsKey(token)) return (found: false, value: null);
      current = current[token];
    } else {
      return (found: false, value: null);
    }
  }
  return (found: true, value: current);
}

/// The value at [pointer], or null when missing.
Object? readAt(Object? data, Pointer pointer) => lookupAt(data, pointer).value;
