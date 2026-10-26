import 'dart:async';
import 'dart:ffi';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:ffi/ffi.dart';

import 'relay_signature_backend.dart';

typedef _VerifyNative =
    Int32 Function(Pointer<Uint8> sig, Pointer<Uint8> id, Pointer<Uint8> key);
typedef _Verify =
    int Function(Pointer<Uint8> sig, Pointer<Uint8> id, Pointer<Uint8> key);

/// Verifies with the app's vendored libsecp256k1, synchronously through FFI.
///
/// The iOS host hands over the address of its BIP-340 check over
/// [channel]. Until it has, checks wait for it. If it does not arrive,
/// checks throw [SignatureCheckUnavailable], so nothing unverified is used,
/// and the next check after [retryAfter] asks the host again.
class NativeSignatureBackend implements RelaySignatureBackend {
  /// A backend that asks [channel] for the native check. Only tests pass
  /// [now].
  NativeSignatureBackend({
    this.channel = const MethodChannel('buzz/relay_signature'),
    this.retryDelay = const Duration(milliseconds: 250),
    this.retryAfter = const Duration(seconds: 30),
    @visibleForTesting DateTime Function()? now,
  }) : _now = now ?? DateTime.now;

  /// The backend the app uses.
  static final shared = NativeSignatureBackend();

  /// Answers `verifierAddress` with the native check's address.
  final MethodChannel channel;

  /// The wait between attempts to reach the host while the engine starts.
  final Duration retryDelay;

  /// How long a failed load fails checks before the host is asked again.
  final Duration retryAfter;

  final DateTime Function() _now;

  static const _attempts = 8;

  _Verify? _verify;
  Future<_Verify?>? _loading;
  DateTime? _retryAt;

  @override
  FutureOr<bool> verify(String id, String pubkey, String sig) {
    final verify = _verify;
    if (verify != null) return _check(verify, id, pubkey, sig);
    if (_retryAt case final retryAt? when _now().isBefore(retryAt)) {
      throw const SignatureCheckUnavailable();
    }
    return (_loading ??= _load()).then((verify) {
      if (verify == null) throw const SignatureCheckUnavailable();
      return _check(verify, id, pubkey, sig);
    });
  }

  /// The native check, or null when the host does not hand one over. A
  /// failure is not kept: it fails checks until [retryAfter] has passed.
  Future<_Verify?> _load() async {
    for (var attempt = 1; attempt <= _attempts; attempt++) {
      try {
        final address = await channel.invokeMethod<int>('verifierAddress');
        if (address == null || address <= 0) break;
        _retryAt = null;
        return _verify = Pointer<NativeFunction<_VerifyNative>>.fromAddress(
          address,
        ).asFunction<_Verify>(isLeaf: true);
      } on MissingPluginException {
        // The host registers the channel as the engine starts.
        if (attempt < _attempts) await Future<void>.delayed(retryDelay);
      } catch (_) {
        // A PlatformException, or an answer that is not an int.
        break;
      }
    }
    debugPrint('relay: native signature check unavailable');
    _retryAt = _now().add(retryAfter);
    _loading = null;
    return null;
  }

  // One native buffer for sig, id and key. Checks run only on the isolate
  // that owns this backend, one at a time, so it is never shared.
  static final Pointer<Uint8> _buffer = malloc<Uint8>(128);

  /// Whether [sig] verifies. False, without calling [verify], unless each
  /// argument is lowercase hex of its exact length, so no stale buffer
  /// bytes from an earlier check are ever read.
  static bool _check(_Verify verify, String id, String pubkey, String sig) {
    if (sig.length != 128 || id.length != 64 || pubkey.length != 64) {
      return false;
    }
    final bytes = _buffer.asTypedList(128);
    if (!_write(bytes, 0, sig) ||
        !_write(bytes, 64, id) ||
        !_write(bytes, 96, pubkey)) {
      return false;
    }
    return verify(_buffer, _buffer + 64, _buffer + 96) == 1;
  }

  /// Writes [hex] as bytes from [offset]; false at the first character
  /// that is not lowercase hex.
  static bool _write(Uint8List out, int offset, String hex) {
    for (var index = 0; index < hex.length; index += 2) {
      final high = _nibble(hex.codeUnitAt(index));
      final low = _nibble(hex.codeUnitAt(index + 1));
      if (high < 0 || low < 0) return false;
      out[offset + index ~/ 2] = high << 4 | low;
    }
    return true;
  }

  static int _nibble(int unit) => switch (unit) {
    >= 0x30 && <= 0x39 => unit - 0x30,
    >= 0x61 && <= 0x66 => unit - 0x61 + 10,
    _ => -1,
  };

  /// [_check] with a stand-in for the native check, for tests of the input
  /// guard; [native] sees the buffer exactly as the native check would.
  @visibleForTesting
  static bool debugCheck(
    String id,
    String pubkey,
    String sig,
    int Function(Uint8List sig, Uint8List id, Uint8List key) native,
  ) => _check(
    (sigPointer, idPointer, keyPointer) => native(
      sigPointer.asTypedList(64),
      idPointer.asTypedList(32),
      keyPointer.asTypedList(32),
    ),
    id,
    pubkey,
    sig,
  );
}
