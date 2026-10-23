import 'dart:async';

import 'package:flutter/services.dart';

const agentCallMethodChannelName = 'buzz/agent_call';

/// What the native side reports during a call.
enum AgentCallMediaEvent {
  /// Audio connected.
  connected,

  /// The voice session closed from the far side.
  remoteClosed,

  /// The connection failed or did not recover.
  connectionLost,

  /// The system's end button (CallKit) hung up.
  hangup,

  /// The system's mute button changed (see [AgentCallMediaEventData.muted]).
  muted,

  /// Another call or app took the audio; it may come back.
  interrupted,

  /// The audio came back.
  resumed,
}

class AgentCallMediaEventData {
  const AgentCallMediaEventData(this.event, {this.muted});

  final AgentCallMediaEvent event;
  final bool? muted;
}

class AgentCallOffer {
  const AgentCallOffer({required this.sdp, required this.systemCallUI});

  final String sdp;

  /// `callkit`, or `in_app` when CallKit refused and the app runs the audio.
  final String systemCallUI;
}

class AgentCallMediaException implements Exception {
  const AgentCallMediaException(this.code);

  final String code;

  @override
  String toString() => 'AgentCallMediaException($code)';
}

/// The phone's media for a 1:1 agent call: microphone, the WebRTC offer and
/// answer, mute, and the system call (CallKit). Native in `AgentCallPlugin`.
abstract interface class AgentCallMedia {
  Stream<AgentCallMediaEventData> get events;

  /// Asks for the microphone, starts the system call and returns the offer.
  Future<AgentCallOffer> begin({required String agentName});

  Future<void> accept(String sdpAnswer);

  Future<void> setMuted(bool muted);

  /// Closes the media and ends the system call.
  Future<void> end();
}

final class MethodChannelAgentCallMedia implements AgentCallMedia {
  MethodChannelAgentCallMedia({MethodChannel? channel})
    : _channel = channel ?? const MethodChannel(agentCallMethodChannelName) {
    _channel.setMethodCallHandler(_handle);
  }

  final MethodChannel _channel;
  final _events = StreamController<AgentCallMediaEventData>.broadcast();

  @override
  Stream<AgentCallMediaEventData> get events => _events.stream;

  Future<Object?> _handle(MethodCall call) async {
    if (call.method != 'event') return null;
    final arguments = call.arguments;
    if (arguments is! Map) return null;
    final event = switch (arguments['type']) {
      'connected' => AgentCallMediaEvent.connected,
      'remoteClosed' => AgentCallMediaEvent.remoteClosed,
      'connectionLost' => AgentCallMediaEvent.connectionLost,
      'hangup' => AgentCallMediaEvent.hangup,
      'muted' => AgentCallMediaEvent.muted,
      'interrupted' => AgentCallMediaEvent.interrupted,
      'resumed' => AgentCallMediaEvent.resumed,
      _ => null,
    };
    if (event == null) return null;
    final muted = arguments['muted'];
    _events.add(
      AgentCallMediaEventData(event, muted: muted is bool ? muted : null),
    );
    return null;
  }

  @override
  Future<AgentCallOffer> begin({required String agentName}) async {
    try {
      final result = await _channel.invokeMapMethod<String, Object?>('begin', {
        'agentName': agentName,
      });
      final sdp = result?['sdp'];
      if (sdp is! String || sdp.isEmpty) {
        throw const AgentCallMediaException('media_failed');
      }
      final ui = result?['systemCallUI'];
      return AgentCallOffer(
        sdp: sdp,
        systemCallUI: ui is String ? ui : 'callkit',
      );
    } on PlatformException catch (error) {
      throw AgentCallMediaException(error.code);
    } on MissingPluginException {
      throw const AgentCallMediaException('unsupported');
    }
  }

  @override
  Future<void> accept(String sdpAnswer) async {
    try {
      await _channel.invokeMethod<void>('accept', {'sdp': sdpAnswer});
    } on PlatformException catch (error) {
      throw AgentCallMediaException(error.code);
    }
  }

  @override
  Future<void> setMuted(bool muted) async {
    try {
      await _channel.invokeMethod<void>('setMuted', {'muted': muted});
    } on PlatformException {
      // The track state is best effort; the screen still shows the choice.
    }
  }

  @override
  Future<void> end() async {
    try {
      await _channel.invokeMethod<void>('end');
    } on PlatformException {
      // Already ended.
    } on MissingPluginException {
      // No native side (tests, other platforms).
    }
  }
}
