import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../../shared/community/community_provider.dart';
import '../../shared/guest_access/guest_access_client.dart';
import '../../shared/huddle/huddle.dart';
import '../../shared/relay/relay.dart';
import 'agent_call_api.dart';
import 'agent_call_feed.dart';
import 'agent_call_media.dart';

/// The app's one 1:1 agent call (the host allows one per person): the same
/// voice core and call screen contract as the host's own phone apps. Media
/// is native (`AgentCallMedia`); the host answers the offer only from the
/// caller's private DM with the agent. The call screen follows the host's
/// feed long-poll (wait 20 s, backing off 1 s → 15 s), and after hang-up
/// until the recap is written (at most 90 s).
///
/// Hang-up ends the call only; the agent's work goes on and its answers
/// land in the DM. Stop stops the work.

enum AgentCallPhase { idle, connecting, live, ending, ended, error }

enum AgentCallStopStatus { idle, stopping, stopped, nothingToStop, failed }

@immutable
class AgentCallState {
  const AgentCallState({
    this.phase = AgentCallPhase.idle,
    this.agentPubkey,
    this.agentName,
    this.channelId,
    this.callId,
    this.connectedAt,
    this.muted = false,
    this.stop = AgentCallStopStatus.idle,
    this.error,
    this.endReason,
    this.feed,
  });

  final AgentCallPhase phase;
  final String? agentPubkey;
  final String? agentName;
  final String? channelId;
  final String? callId;
  final DateTime? connectedAt;
  final bool muted;
  final AgentCallStopStatus stop;
  final String? error;
  final String? endReason;
  final AgentCallFeed? feed;

  bool get isBusy =>
      phase == AgentCallPhase.connecting ||
      phase == AgentCallPhase.live ||
      phase == AgentCallPhase.ending;

  AgentCallState copyWith({
    AgentCallPhase? phase,
    String? callId,
    DateTime? connectedAt,
    bool? muted,
    AgentCallStopStatus? stop,
    String? error,
    String? endReason,
    AgentCallFeed? feed,
  }) => AgentCallState(
    phase: phase ?? this.phase,
    agentPubkey: agentPubkey,
    agentName: agentName,
    channelId: channelId,
    callId: callId ?? this.callId,
    connectedAt: connectedAt ?? this.connectedAt,
    muted: muted ?? this.muted,
    stop: stop ?? this.stop,
    error: error ?? this.error,
    endReason: endReason ?? this.endReason,
    feed: feed ?? this.feed,
  );
}

/// The native media seam (overridden in tests).
final agentCallMediaProvider = Provider<AgentCallMedia>(
  (ref) => MethodChannelAgentCallMedia(),
);

/// The host's call routes for the active community and signed-in key.
final agentCallApiProvider = Provider<AgentCallApi?>((ref) {
  final route = ref.watch(guestAccessRouteProvider);
  final nsec = ref.watch(relayConfigProvider.select((config) => config.nsec));
  if (route == null || nsec == null || nsec.isEmpty) return null;
  final origin = agentCallOrigin(route);
  if (origin == null) return null;
  final api = AgentCallApi(
    origin: origin,
    communityId: route.communityId,
    nsec: nsec,
  );
  ref.onDispose(api.close);
  return api;
});

/// Whether a huddle holds the audio now (a call waits for it to end).
final agentCallHuddleBusyProvider = Provider<bool>(
  (ref) => ref.watch(huddleSessionProvider).isInSession,
);

final agentCallProvider = NotifierProvider<AgentCallNotifier, AgentCallState>(
  AgentCallNotifier.new,
);

@visibleForTesting
Duration agentCallFeedRetryDelay(int failures) => Duration(
  milliseconds: math.min(
    15000,
    1000 * math.pow(2, math.max(0, failures - 1)).toInt(),
  ),
);

const _endedDismiss = Duration(seconds: 4);
const _stopStatusReset = Duration(seconds: 4);
const _feedAfterEnd = Duration(seconds: 90);
const _resumeTimeout = Duration(seconds: 8);

class AgentCallNotifier extends Notifier<AgentCallState> {
  int _attempt = 0;
  int _feedToken = 0;
  AgentCallApi? _api;
  StreamSubscription<AgentCallMediaEventData>? _events;
  final List<Timer> _timers = [];
  Timer? _resumeTimer;

  @override
  AgentCallState build() {
    final media = ref.watch(agentCallMediaProvider);
    _events = media.events.listen(_onMediaEvent);
    final unregister = ref
        .read(communityTransitionProvider)
        .register(() async => reset());
    ref.onDispose(() {
      unregister();
      _events?.cancel();
      _clearTimers();
    });
    return const AgentCallState();
  }

  AgentCallMedia get _media => ref.read(agentCallMediaProvider);

  void _later(Duration delay, void Function() callback) {
    late final Timer timer;
    timer = Timer(delay, () {
      _timers.remove(timer);
      callback();
    });
    _timers.add(timer);
  }

  void _clearTimers() {
    for (final timer in _timers) {
      timer.cancel();
    }
    _timers.clear();
    _resumeTimer?.cancel();
    _resumeTimer = null;
  }

  /// Starts a call from the caller's 1:1 DM with the agent.
  Future<void> start({
    required String agentPubkey,
    required String channelId,
    required String agentName,
  }) async {
    if (state.isBusy) return;
    _clearTimers();
    _feedToken++;
    final attempt = ++_attempt;
    final tapAt = DateTime.now().toUtc().toIso8601String();
    state = AgentCallState(
      phase: AgentCallPhase.connecting,
      agentPubkey: agentPubkey,
      agentName: agentName,
      channelId: channelId,
    );
    if (ref.read(agentCallHuddleBusyProvider)) {
      _fail('Leave the huddle first, then call.');
      return;
    }
    final api = ref.read(agentCallApiProvider);
    if (api == null) {
      _fail("Calls aren't available for this community.");
      return;
    }
    _api = api;

    AgentCallOffer offer;
    try {
      offer = await _media.begin(agentName: agentName);
    } on AgentCallMediaException catch (error) {
      if (attempt == _attempt) _fail(_describeMediaError(error.code));
      return;
    }
    if (attempt != _attempt) {
      unawaited(_media.end());
      return;
    }

    AgentCallStart started;
    try {
      started = await api.start(
        agentPubkey: agentPubkey,
        channelId: channelId,
        sdpOffer: offer.sdp,
        clientTapAt: tapAt,
        systemCallUI: offer.systemCallUI,
      );
    } catch (error) {
      if (attempt == _attempt) {
        unawaited(_media.end());
        _fail(describeAgentCallError(error));
      }
      return;
    }
    if (attempt != _attempt) {
      // Hung up while the host was answering: end the call it opened.
      unawaited(_quietEnd(api, started.callId, 'hangup'));
      return;
    }
    state = state.copyWith(callId: started.callId);
    _followFeed(api, started.callId);

    try {
      await _media.accept(started.sdpAnswer);
    } on AgentCallMediaException {
      if (attempt == _attempt) {
        unawaited(_quietEnd(api, started.callId, 'media_failed'));
        unawaited(_media.end());
        _fail("The call connected but audio couldn't start. Try again.");
      }
      return;
    }
    final until = started.executeUntil;
    if (until != null) {
      _later(until.difference(DateTime.now()), () {
        if (attempt == _attempt && state.isBusy) {
          unawaited(_finish('time_limit'));
        }
      });
    }
  }

  void _onMediaEvent(AgentCallMediaEventData data) {
    switch (data.event) {
      case AgentCallMediaEvent.connected:
        if (state.phase == AgentCallPhase.connecting) {
          state = state.copyWith(
            phase: AgentCallPhase.live,
            connectedAt: DateTime.now(),
          );
        }
      case AgentCallMediaEvent.remoteClosed:
        unawaited(_finish('remote', mediaClosed: true));
      case AgentCallMediaEvent.connectionLost:
        if (state.phase == AgentCallPhase.connecting) {
          final api = _api;
          final callId = state.callId;
          if (api != null && callId != null) {
            unawaited(_quietEnd(api, callId, 'media_failed'));
          }
          _fail(
            "Audio couldn't connect. A firewall or VPN may be blocking calls.",
          );
        } else {
          unawaited(_finish('connection_lost', mediaClosed: true));
        }
      case AgentCallMediaEvent.hangup:
        unawaited(_finish('hangup', mediaClosed: true));
      case AgentCallMediaEvent.muted:
        if (state.isBusy && data.muted != null) {
          state = state.copyWith(muted: data.muted);
        }
      case AgentCallMediaEvent.interrupted:
        if (state.phase != AgentCallPhase.live) return;
        _resumeTimer?.cancel();
        final attempt = _attempt;
        _resumeTimer = Timer(_resumeTimeout, () {
          if (attempt == _attempt && state.phase == AgentCallPhase.live) {
            unawaited(_finish('media_failed'));
          }
        });
      case AgentCallMediaEvent.resumed:
        _resumeTimer?.cancel();
        _resumeTimer = null;
    }
  }

  void _followFeed(AgentCallApi api, String callId) {
    final token = ++_feedToken;
    unawaited(_runFeed(api, token, callId));
  }

  Future<void> _runFeed(AgentCallApi api, int token, String callId) async {
    String? rev;
    var failures = 0;
    DateTime? until;
    while (token == _feedToken) {
      final ended = !state.isBusy;
      if (ended) {
        final feed = state.feed;
        if (feed != null && !feed.wantsMore) return;
        until ??= DateTime.now().add(_feedAfterEnd);
        if (DateTime.now().isAfter(until)) return;
      }
      try {
        final (feed, nextRev) = await api.feed(
          callId,
          rev: rev,
          waitSeconds: ended ? 5 : 20,
        );
        failures = 0;
        if (token != _feedToken) return;
        rev = nextRev ?? rev;
        if (feed != null && feed.callId == callId) {
          state = state.copyWith(feed: feed);
        }
      } on AgentCallApiException catch (error) {
        if (token != _feedToken) return;
        if (error.status == 404 || error.status == 403 || error.status == 401) {
          return;
        }
        failures++;
        await Future<void>.delayed(agentCallFeedRetryDelay(failures));
      } catch (_) {
        if (token != _feedToken) return;
        failures++;
        await Future<void>.delayed(agentCallFeedRetryDelay(failures));
      }
    }
  }

  void toggleMute() {
    if (!state.isBusy) return;
    final muted = !state.muted;
    state = state.copyWith(muted: muted);
    unawaited(_media.setMuted(muted));
  }

  /// Stops the agent's current work; the call goes on.
  Future<void> stopAgentWork() async {
    final api = _api;
    final callId = state.callId;
    if (api == null || callId == null) return;
    if (state.stop == AgentCallStopStatus.stopping) return;
    final attempt = _attempt;
    state = state.copyWith(stop: AgentCallStopStatus.stopping);
    AgentCallStopStatus next;
    try {
      next = switch (await api.stopWork(callId)) {
        AgentCallStopOutcome.stopped => AgentCallStopStatus.stopped,
        AgentCallStopOutcome.nothingToStop => AgentCallStopStatus.nothingToStop,
      };
    } catch (_) {
      next = AgentCallStopStatus.failed;
    }
    if (attempt != _attempt) return;
    state = state.copyWith(stop: next);
    _later(_stopStatusReset, () {
      if (attempt == _attempt && state.stop == next) {
        state = state.copyWith(stop: AgentCallStopStatus.idle);
      }
    });
  }

  /// Hangs up. The agent keeps working; its answers land in the DM.
  Future<void> hangUp() => _finish('hangup');

  Future<void> answerQuestion({
    required String humanAskId,
    required String? questionId,
    required int optionIndex,
  }) async {
    final api = _api;
    final callId = state.callId;
    if (api == null || callId == null) return;
    await api.answerQuestion(
      callId: callId,
      humanAskId: humanAskId,
      questionId: questionId,
      optionIndex: optionIndex,
    );
  }

  Future<void> cancelAsk(String askKey) async {
    final api = _api;
    final callId = state.callId;
    if (api == null || callId == null) return;
    await api.cancelAsk(callId, askKey);
  }

  Future<void> archiveAsk(String askKey) async {
    final api = _api;
    final callId = state.callId;
    if (api == null || callId == null) return;
    await api.archiveAsk(callId, askKey);
  }

  Future<void> _finish(String reason, {bool mediaClosed = false}) async {
    if (!state.isBusy) return;
    final callId = state.callId;
    final api = _api;
    final attempt = ++_attempt;
    _clearTimers();
    if (!mediaClosed) unawaited(_media.end());
    state = state.copyWith(phase: AgentCallPhase.ending, endReason: reason);
    if (api != null && callId != null) await _quietEnd(api, callId, reason);
    if (attempt != _attempt) return;
    state = state.copyWith(phase: AgentCallPhase.ended);
    // A call with something on its screen keeps it (the recap) until
    // closed; an empty one goes away.
    _later(_endedDismiss, () {
      if (attempt == _attempt &&
          state.phase == AgentCallPhase.ended &&
          (state.feed?.asks.isEmpty ?? true)) {
        dismiss();
      }
    });
  }

  Future<void> _quietEnd(AgentCallApi api, String callId, String reason) async {
    try {
      await api.end(callId, reason);
    } catch (_) {
      // The host's sweep ends a call nobody holds.
    }
  }

  void _fail(String message) {
    _attempt++;
    _feedToken++;
    _clearTimers();
    state = state.copyWith(phase: AgentCallPhase.error, error: message);
  }

  /// Closes the error or "Call ended" screen.
  void dismiss() {
    if (state.isBusy) return;
    _attempt++;
    _feedToken++;
    _clearTimers();
    state = const AgentCallState();
  }

  /// A community or account switch: hang up and clear the screen.
  void reset() {
    final api = _api;
    final callId = state.callId;
    if (state.isBusy) {
      unawaited(_media.end());
      if (api != null && callId != null) {
        unawaited(_quietEnd(api, callId, 'community_changed'));
      }
    }
    _attempt++;
    _feedToken++;
    _clearTimers();
    _api = null;
    state = const AgentCallState();
  }

  String _describeMediaError(String code) => switch (code) {
    'mic_denied' =>
      'Microphone access is off for Buzz. Allow it in Settings, then call again.',
    'call_in_progress' => "You're already on a call.",
    'audio_unavailable' => "The phone's audio is busy. Try again.",
    'unsupported' => "Calls aren't available on this device.",
    _ => "The call couldn't be set up. Try again.",
  };
}
