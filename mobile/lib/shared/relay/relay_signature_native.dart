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
/// The iOS host hands over the address of its BIP-340 check once, over
/// [channel]. Until it has, checks wait for it; if it never arrives, every
/// check fails, so nothing unverified is ever used.
class NativeSignatureBackend implements RelaySignatureBackend {
  /// A backend that asks [channel] for the native check.
  NativeSignatureBackend({
    this.channel = const MethodChannel('buzz/relay_signature'),
    this.retryDelay = const Duration(milliseconds: 250),
  });

  /// The backend the app uses.
  static final shared = NativeSignatureBackend();

  /// Answers `verifierAddress` with the native check's address.
  final MethodChannel channel;

  /// The wait between attempts to reach the host while the engine starts.
  final Duration retryDelay;

  static const _attempts = 8;

  _Verify? _verify;
  Future<_Verify?>? _loading;

  @override
  FutureOr<bool> verify(String id, String pubkey, String sig) {
    final verify = _verify;
    if (verify != null) return _check(verify, id, pubkey, sig);
    return (_loading ??= _load()).then(
      (verify) => verify != null && _check(verify, id, pubkey, sig),
    );
  }

  Future<_Verify?> _load() async {
    for (var attempt = 1; attempt <= _attempts; attempt++) {
      try {
        final address = await channel.invokeMethod<int>('verifierAddress');
        if (address == null || address == 0) break;
        return _verify = Pointer<NativeFunction<_VerifyNative>>.fromAddress(
          address,
        ).asFunction<_Verify>(isLeaf: true);
      } on MissingPluginException {
        // The host registers the channel as the engine starts.
        if (attempt < _attempts) await Future<void>.delayed(retryDelay);
      } on PlatformException {
        break;
      }
    }
    debugPrint('relay: native signature check unavailable');
    return null;
  }

  // One native buffer for sig, id and key. Checks run only on the isolate
  // that owns this backend, one at a time, so it is never shared.
  static final Pointer<Uint8> _buffer = malloc<Uint8>(128);

  static bool _check(_Verify verify, String id, String pubkey, String sig) {
    final bytes = _buffer.asTypedList(128);
    _write(bytes, 0, sig);
    _write(bytes, 64, id);
    _write(bytes, 96, pubkey);
    return verify(_buffer, _buffer + 64, _buffer + 96) == 1;
  }

  /// Writes lowercase hex, already shape-checked, as bytes from [offset].
  static void _write(Uint8List out, int offset, String hex) {
    for (var index = 0; index < hex.length ~/ 2; index++) {
      out[offset + index] = int.parse(
        hex.substring(index * 2, index * 2 + 2),
        radix: 16,
      );
    }
  }
}
