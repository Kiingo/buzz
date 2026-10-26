import 'dart:async';
import 'dart:collection';

/// Applies relay socket messages in the order they arrived, holding each
/// message, and every message after it, until the signature check of the
/// event it carries has settled. So no event reaches a subscriber, and no
/// EOSE marks a subscription ready, before the events ahead of it are
/// verified. A message whose check settles synchronously, with nothing
/// held, applies at once.
class RelayIngestQueue {
  final _held = Queue<_Held>();
  int _epoch = 0;

  /// Whether no message is waiting on a check.
  bool get isIdle => _held.isEmpty;

  /// Applies [apply] with the outcome of [verdict], in arrival order. A
  /// check that fails with an error counts as a failed check.
  void add(FutureOr<bool> verdict, void Function(bool valid) apply) {
    if (_held.isEmpty && verdict is bool) {
      apply(verdict);
      return;
    }
    final held = _Held(apply);
    _held.add(held);
    if (verdict is bool) {
      held.settle(verdict);
      return;
    }
    final epoch = _epoch;
    verdict.then((valid) => valid, onError: (Object _) => false).then((valid) {
      if (epoch != _epoch) return;
      held.settle(valid);
      _drain();
    });
  }

  /// Drops every held message: the connection or session they came from
  /// has gone, and checks still running for them are ignored.
  void clear() {
    _epoch++;
    _held.clear();
  }

  void _drain() {
    final epoch = _epoch;
    while (epoch == _epoch && _held.isNotEmpty && _held.first.settled) {
      final held = _held.removeFirst();
      try {
        held.apply(held.valid);
      } catch (error, stack) {
        // Report it as the socket callback would have, and keep the order.
        Zone.current.handleUncaughtError(error, stack);
      }
    }
  }
}

class _Held {
  _Held(this.apply);

  final void Function(bool valid) apply;
  bool settled = false;
  bool valid = false;

  void settle(bool value) {
    settled = true;
    valid = value;
  }
}
