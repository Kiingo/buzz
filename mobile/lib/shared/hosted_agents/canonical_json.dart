import 'dart:convert';
import 'dart:typed_data';

import 'package:pointycastle/digests/sha256.dart';

/// Recursively sort object keys so two encoders produce identical bytes.
///
/// Mirrors the provider's `stable_json` and the API's `stableBuzzHostedJSON`:
/// keys sort by UTF-16 code unit (the same order for the ASCII keys the
/// contract uses), arrays keep their order, and scalars are unchanged.
Object? canonicalizeJson(Object? value) {
  if (value is List) return value.map(canonicalizeJson).toList();
  if (value is Map) {
    final keys = value.keys.map((key) => key.toString()).toList()..sort();
    return {for (final key in keys) key: canonicalizeJson(value[key])};
  }
  return value;
}

/// Compact JSON with sorted keys, byte-compatible with `JSON.stringify` and
/// `serde_json::to_string` for the strings, integers, booleans and nulls the
/// hosted-agent contract carries.
String stableJson(Object? value) => jsonEncode(canonicalizeJson(value));

/// Lowercase hex SHA-256 of [bytes].
String sha256Hex(List<int> bytes) =>
    hexEncode(SHA256Digest().process(Uint8List.fromList(bytes)));

/// Lowercase hex SHA-256 of [value]'s [stableJson] UTF-8 bytes.
String stableJsonSha256(Object? value) =>
    sha256Hex(utf8.encode(stableJson(value)));

/// Lowercase hex encoding.
String hexEncode(List<int> bytes) =>
    bytes.map((byte) => byte.toRadixString(16).padLeft(2, '0')).join();

/// Decode lowercase or uppercase hex, or throw [FormatException].
Uint8List hexDecode(String value) {
  if (value.length.isOdd || !RegExp(r'^[0-9a-fA-F]*$').hasMatch(value)) {
    throw const FormatException('invalid hex');
  }
  final out = Uint8List(value.length ~/ 2);
  for (var index = 0; index < out.length; index++) {
    out[index] = int.parse(
      value.substring(index * 2, index * 2 + 2),
      radix: 16,
    );
  }
  return out;
}
