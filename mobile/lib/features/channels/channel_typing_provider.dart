import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../../shared/relay/relay.dart';

/// Status an agent can attach to its typing pulse (`{"v":1,"phase":...}`
/// in the ephemeral kind:20002 content). Absent or unknown means plain
/// "is typing…"; `idle` ends the sender's typing at once.
enum TypingPhase { starting, warming, reconnecting, working, typing, idle }

/// Parses a typing pulse's optional status payload.
TypingPhase? parseTypingPhase(String content) {
  if (content.isEmpty || content.length > 512) return null;
  try {
    final value = jsonDecode(content);
    if (value is! Map || value['v'] != 1) return null;
    final phase = value['phase'];
    if (phase is! String) return null;
    for (final candidate in TypingPhase.values) {
      if (candidate.name == phase) return candidate;
    }
  } on FormatException {
    return null;
  }
  return null;
}

/// The status-line words after the sender's name, e.g. "is starting up…".
String typingPhaseSentence(TypingPhase? phase) => switch (phase) {
  TypingPhase.starting => 'is starting up…',
  TypingPhase.warming => 'is warming up a session…',
  TypingPhase.reconnecting => 'is reconnecting…',
  TypingPhase.working => 'is working…',
  _ => 'is typing…',
};

/// A single typing indicator entry.
@immutable
class TypingEntry {
  final String pubkey;
  final String? threadHeadId;
  final int expiresAtMs;

  /// The latest pulse's status; null is plain "is typing…".
  final TypingPhase? phase;

  const TypingEntry({
    required this.pubkey,
    this.threadHeadId,
    required this.expiresAtMs,
    this.phase,
  });
}

/// Tracks who is currently typing in a specific channel.
///
/// Subscribes to typing and message events so a reply ends its typing signal.
/// Entries expire after 8 seconds (matching the desktop TTL).
class ChannelTypingNotifier extends Notifier<List<TypingEntry>> {
  static const _ttlMs = 8000;
  static const _pruneIntervalMs = 1000;

  final String channelId;
  void Function()? _unsubscribe;
  Timer? _pruneTimer;
  Timer? _retryTimer;
  Timer? _healthyTimer;
  int _generation = 0;
  final _activity = <(String, String?), _TypingActivity>{};

  ChannelTypingNotifier(this.channelId);

  @override
  List<TypingEntry> build() {
    final sessionState = ref.watch(relaySessionProvider);
    final generation = ++_generation;
    _activity.clear();

    ref.onDispose(() {
      _generation++;
      _activity.clear();
      _unsubscribe?.call();
      _unsubscribe = null;
      _pruneTimer?.cancel();
      _pruneTimer = null;
      _retryTimer?.cancel();
      _retryTimer = null;
      _healthyTimer?.cancel();
      _healthyTimer = null;
    });

    if (sessionState.status == SessionStatus.connected) {
      unawaited(_subscribeLive(generation));
    }

    return [];
  }

  Future<void> _subscribeLive(int generation, [int attempt = 0]) async {
    final session = ref.read(relaySessionProvider.notifier);
    var closed = false;
    var failures = attempt;
    void failed() {
      if (closed) return;
      closed = true;
      // subscribe may invoke onClosed synchronously during provider build.
      scheduleMicrotask(() {
        if (generation != _generation) return;
        _unsubscribe?.call();
        _unsubscribe = null;
        _healthyTimer?.cancel();
        _healthyTimer = null;
        _activity.clear();
        state = [];
        _pruneTimer?.cancel();
        _pruneTimer = null;
        // Bound retries for policy rejections; a transport reconnect resets it.
        if (failures < 3) {
          _retryTimer = Timer(Duration(seconds: 1 << failures), () {
            _retryTimer = null;
            if (generation == _generation) {
              unawaited(_subscribeLive(generation, failures + 1));
            }
          });
        }
      });
    }

    try {
      final unsubscribe = await session.subscribe(
        NostrFilter(
          kinds: [
            EventKind.typingIndicator,
            ...EventKind.channelMessageEventKinds,
            EventKind.streamMessageDiff,
          ],
          tags: {
            '#h': [channelId],
          },
          limit: 10,
        ),
        (event) {
          if (!closed && generation == _generation) _handleTypingEvent(event);
        },
        onClosed: (_) => failed(),
      );
      if (closed || generation != _generation) {
        unsubscribe();
      } else {
        // Admission alone is not health: repeated terminal rejections may
        // arrive after subscribe's readiness timeout. Reset only after a full
        // typing TTL of uninterrupted subscription health.
        _healthyTimer = Timer(const Duration(milliseconds: _ttlMs), () {
          if (!closed && generation == _generation) failures = 0;
        });
        _unsubscribe = unsubscribe;
      }
    } catch (_) {
      failed();
    }
  }

  void _handleTypingEvent(NostrEvent event) {
    final now = DateTime.now().millisecondsSinceEpoch;
    final at = event.createdAt * 1000;
    if (event.channelId != channelId || at > now || at + _ttlMs <= now) return;
    // Typing and replies are scoped to the message they answer (the `reply`
    // e-tag), exactly as desktop and the thread view key them.
    final scope = (event.pubkey.toLowerCase(), event.threadReference.parentId);
    _activity.removeWhere((_, value) => value.retainUntil <= now);
    if (!_activity.containsKey(scope) && _activity.length >= 1024) return;
    final record = _activity.putIfAbsent(scope, _TypingActivity.new);
    if (event.kind == EventKind.typingIndicator) {
      if (at <= record.lastActivity || at <= record.lastMessage) return;
      record.lastActivity = at;
      final phase = parseTypingPhase(event.content);
      if (phase == TypingPhase.idle) {
        record.visibleUntil = 0;
      } else {
        record.phase = phase;
        if (now >= record.quietUntil) record.visibleUntil = at + _ttlMs;
      }
    } else {
      if (at <= record.lastMessage) return;
      record.lastMessage = at;
      if (at >= record.lastActivity) {
        record.visibleUntil = 0;
        record.quietUntil = now + 2000;
      }
    }
    _prune();
    _ensurePruneTimer();
  }

  void _ensurePruneTimer() {
    _pruneTimer ??= Timer.periodic(
      const Duration(milliseconds: _pruneIntervalMs),
      (_) => _prune(),
    );
  }

  void _prune() {
    final now = DateTime.now().millisecondsSinceEpoch;
    _activity.removeWhere((_, value) => value.retainUntil <= now);
    state = [
      for (final entry in _activity.entries)
        if (entry.value.visibleUntil > now)
          TypingEntry(
            pubkey: entry.key.$1,
            threadHeadId: entry.key.$2,
            expiresAtMs: entry.value.visibleUntil,
            phase: entry.value.phase,
          ),
    ];
    if (_activity.isEmpty) {
      _pruneTimer?.cancel();
      _pruneTimer = null;
    }
  }
}

final channelTypingProvider =
    NotifierProvider.family<ChannelTypingNotifier, List<TypingEntry>, String>(
      ChannelTypingNotifier.new,
    );

class _TypingActivity {
  int lastActivity = -1;
  int lastMessage = -1;
  int visibleUntil = 0;
  int quietUntil = 0;
  TypingPhase? phase;
  int get retainUntil {
    final expiry =
        (lastActivity > lastMessage ? lastActivity : lastMessage) + 8000;
    return expiry > quietUntil ? expiry : quietUntil;
  }
}
