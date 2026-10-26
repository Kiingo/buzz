import 'dart:async';
import 'dart:collection';
import 'dart:io' show Platform;
import 'dart:isolate';
import 'dart:math';

import 'package:nostr/nostr.dart' as nostr;

import 'relay_signature_native.dart';

/// Checks BIP-340 signatures over Nostr event ids.
abstract interface class RelaySignatureBackend {
  /// Whether [sig] is [pubkey]'s BIP-340 signature of [id], each lowercase
  /// hex of its NIP-01 length. Answers synchronously when it can.
  FutureOr<bool> verify(String id, String pubkey, String sig);
}

/// The backend for this platform: the app's vendored libsecp256k1 through
/// FFI on iOS, and a pool of pure-Dart isolates elsewhere, so a pure-Dart
/// check never runs on the UI isolate.
RelaySignatureBackend platformSignatureBackend() => Platform.isIOS
    ? NativeSignatureBackend.shared
    : IsolateSignatureBackend.shared;

/// The pure-Dart BIP-340 check; false for anything that is not a valid
/// signature, including input it cannot decode.
bool verifyBip340(String id, String pubkey, String sig) {
  try {
    return nostr.Schnorr.verify(publicKey: pubkey, message: id, signature: sig);
  } catch (_) {
    return false;
  }
}

/// Verifies on short-lived background isolates, at most [workers] at a
/// time. Requests made in the same microtask turn travel together in chunks
/// of at most [chunkSize], so a burst is checked in parallel and in order.
class IsolateSignatureBackend implements RelaySignatureBackend {
  /// A pool of at most [workers] concurrent isolates.
  IsolateSignatureBackend({this.workers = 2, this.chunkSize = 32})
    : assert(workers > 0 && chunkSize > 0);

  /// The process-wide pool, sized to leave a core for the UI.
  static final shared = IsolateSignatureBackend(
    workers: max(1, min(3, Platform.numberOfProcessors - 1)),
  );

  /// How many isolates may verify at once.
  final int workers;

  /// The most signatures one isolate checks per run.
  final int chunkSize;

  List<_Request>? _batch;
  final _chunks = Queue<List<_Request>>();
  int _running = 0;

  @override
  Future<bool> verify(String id, String pubkey, String sig) {
    final request = _Request(id, pubkey, sig);
    final batch = _batch ??= _startBatch();
    batch.add(request);
    return request.result.future;
  }

  List<_Request> _startBatch() {
    scheduleMicrotask(() {
      final batch = _batch!;
      _batch = null;
      final size = min(chunkSize, (batch.length / workers).ceil());
      for (var start = 0; start < batch.length; start += size) {
        _chunks.add(batch.sublist(start, min(start + size, batch.length)));
      }
      _pump();
    });
    return [];
  }

  void _pump() {
    while (_running < workers && _chunks.isNotEmpty) {
      final chunk = _chunks.removeFirst();
      _running++;
      _verifyOnIsolate([
            for (final request in chunk)
              [request.id, request.pubkey, request.sig],
          ])
          .then(
            (results) {
              for (var index = 0; index < chunk.length; index++) {
                chunk[index].result.complete(results[index]);
              }
            },
            onError: (Object _) {
              // An isolate that cannot run verifies nothing.
              for (final request in chunk) {
                request.result.complete(false);
              }
            },
          )
          .whenComplete(() {
            _running--;
            _pump();
          });
    }
  }
}

// Top-level so the isolate closure captures only the signature triples.
Future<List<bool>> _verifyOnIsolate(List<List<String>> items) => Isolate.run(
  () => [for (final item in items) verifyBip340(item[0], item[1], item[2])],
);

class _Request {
  _Request(this.id, this.pubkey, this.sig);

  final String id;
  final String pubkey;
  final String sig;
  final result = Completer<bool>();
}
