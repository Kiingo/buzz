import AVFoundation
import CallKit
import Flutter
import UIKit
import os
@preconcurrency import WebRTC

/// Which feature holds the shared `AVAudioSession` (main thread only). An
/// agent call holds it from `begin` until its media is torn down; while it
/// does, huddle media never configures, reactivates or deactivates it.
enum VoiceAudioSessionOwner {
  nonisolated(unsafe) static var agentCallActive = false
}

/// Native media for 1:1 agent calls from an agent DM (`buzz/agent_call`).
///
/// A proper voice call with the agent through its host's voice core, not a
/// huddle: one WebRTC peer connection to the host's realtime voice provider
/// (a microphone track out, the agent's voice in, and the `oai-events` data
/// channel watched only for the session closing). Dart sends the SDP offer
/// to the host, which answers it; no secret is on the phone.
///
/// The call is an outgoing CallKit call, so it keeps going on the lock
/// screen and in other apps and the system's mute and end buttons work. It
/// is kept out of Recents. CallKit owns the audio session; WebRTC runs in
/// manual-audio mode, its audio unit starting only when CallKit activates
/// the session. If CallKit refuses, the same call runs on the app's own
/// audio session. Interruptions, route changes and media-service resets are
/// watched: when an interruption ends the session is reactivated; if audio
/// never comes back the Dart controller ends the call.
///
/// The provider is created when the plugin is (at engine start), not at the
/// first call, mirroring the host's own phone apps.
@MainActor
final class AgentCallPlugin: NSObject, CXProviderDelegate, RTCPeerConnectionDelegate,
  RTCDataChannelDelegate
{
  private static let factory: RTCPeerConnectionFactory = {
    RTCInitializeSSL()
    return RTCPeerConnectionFactory(
      encoderFactory: RTCDefaultVideoEncoderFactory(),
      decoderFactory: RTCDefaultVideoDecoderFactory())
  }()

  private let channel: FlutterMethodChannel
  private let provider: CXProvider
  private let callController = CXCallController()
  private let log = Logger(subsystem: "buzz", category: "agent-call")
  private var observers: [NSObjectProtocol] = []

  /// The one call: its CallKit id, and whether it runs without CallKit.
  private var callId: UUID?
  private var inApp = false
  private var connection: RTCPeerConnection?
  private var dataChannel: RTCDataChannel?
  private var track: RTCAudioTrack?
  private var connected = false
  private var closed = true

  init(messenger: FlutterBinaryMessenger) {
    channel = FlutterMethodChannel(name: "buzz/agent_call", binaryMessenger: messenger)
    let configuration = CXProviderConfiguration()
    configuration.supportsVideo = false
    configuration.maximumCallGroups = 1
    configuration.maximumCallsPerCallGroup = 1
    configuration.supportedHandleTypes = [.generic]
    configuration.includesCallsInRecents = false
    provider = CXProvider(configuration: configuration)
    super.init()
    provider.setDelegate(self, queue: .main)
    RTCAudioSessionConfiguration.setWebRTC(Self.audioConfiguration())
    let audio = RTCAudioSession.sharedInstance()
    audio.useManualAudio = true
    audio.isAudioEnabled = false
    channel.setMethodCallHandler { [weak self] call, result in
      MainActor.assumeIsolated { self?.handle(call, result: result) }
    }
    watchAudioSession()
  }

  // MARK: Method channel

  private func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    let arguments = call.arguments as? [String: Any] ?? [:]
    switch call.method {
    case "begin":
      let name = Self.callerName(arguments["agentName"] as? String)
      Task { @MainActor in await self.begin(agentName: name, result: result) }
    case "accept":
      guard let sdp = arguments["sdp"] as? String, !sdp.isEmpty else {
        result(FlutterError(code: "invalid_arguments", message: nil, details: nil))
        return
      }
      Task { @MainActor in await self.accept(answer: sdp, result: result) }
    case "setMuted":
      setMuted(arguments["muted"] as? Bool ?? false)
      result(nil)
    case "end":
      Task { @MainActor in
        await self.end()
        result(nil)
      }
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  /// The agent's name as CallKit shows it: trimmed, control characters
  /// dropped, at most 60 characters, "Agent" when nothing is left.
  static func callerName(_ raw: String?) -> String {
    let cleaned = String(
      String.UnicodeScalarView(
        (raw ?? "").unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) })
    ).trimmingCharacters(in: .whitespacesAndNewlines)
    let name = String(cleaned.prefix(60)).trimmingCharacters(in: .whitespacesAndNewlines)
    return name.isEmpty ? "Agent" : name
  }

  private func emit(_ type: String, _ extra: [String: Any] = [:]) {
    var payload = extra
    payload["type"] = type
    channel.invokeMethod("event", arguments: payload)
  }

  // MARK: Call lifecycle

  private func begin(agentName: String, result: @escaping FlutterResult) async {
    if !closed || callId != nil {
      result(FlutterError(code: "call_in_progress", message: nil, details: nil))
      return
    }
    guard await Self.requestMicrophone() else {
      result(FlutterError(code: "mic_denied", message: nil, details: nil))
      return
    }
    let id = UUID()
    callId = id
    closed = false
    connected = false
    VoiceAudioSessionOwner.agentCallActive = true
    let handle = CXHandle(type: .generic, value: agentName)
    let action = CXStartCallAction(call: id, handle: handle)
    action.isVideo = false
    do {
      try await request(action)
      inApp = false
      let update = CXCallUpdate()
      update.remoteHandle = handle
      update.localizedCallerName = agentName
      update.hasVideo = false
      update.supportsHolding = false
      update.supportsGrouping = false
      update.supportsUngrouping = false
      update.supportsDTMF = false
      provider.reportCall(with: id, updated: update)
    } catch {
      let nsError = error as NSError
      log.error(
        "CallKit refused the call: \(nsError.domain, privacy: .public) \(nsError.code, privacy: .public)"
      )
      guard Self.reactivateAudio() else {
        reset()
        result(FlutterError(code: "audio_unavailable", message: nil, details: nil))
        return
      }
      inApp = true
    }
    do {
      let sdp = try await makeOffer()
      result(["sdp": sdp, "systemCallUI": inApp ? "in_app" : "callkit"])
    } catch {
      await end()
      result(FlutterError(code: "media_failed", message: nil, details: nil))
    }
  }

  private func accept(answer: String, result: @escaping FlutterResult) async {
    guard let connection, !closed, let callId else {
      result(FlutterError(code: "no_call", message: nil, details: nil))
      return
    }
    do {
      try await connection.setRemoteDescription(
        RTCSessionDescription(type: .answer, sdp: answer))
      if !inApp {
        provider.reportOutgoingCall(with: callId, startedConnectingAt: Date())
      }
      result(nil)
    } catch {
      result(FlutterError(code: "media_failed", message: nil, details: nil))
    }
  }

  private func setMuted(_ muted: Bool) {
    track?.isEnabled = !muted
    guard let callId, !inApp else { return }
    Task { @MainActor in
      try? await self.request(CXSetMutedCallAction(call: callId, muted: muted))
    }
  }

  /// Hangs up: closes the media and ends the system call.
  private func end() async {
    let id = callId
    let wasInApp = inApp
    closeMedia()
    // Our own hang-up: CallKit's end action that follows is not news.
    closed = true
    guard let id else {
      reset()
      return
    }
    if wasInApp {
      endInAppAudio()
      reset()
      return
    }
    do {
      try await request(CXEndCallAction(call: id))
    } catch {
      provider.reportCall(with: id, endedAt: Date(), reason: .remoteEnded)
    }
    reset()
  }

  /// The call ended from the network side: tell CallKit, then Dart.
  private func endedRemotely(_ type: String) {
    guard !closed, let id = callId else { return }
    closeMedia()
    if inApp {
      endInAppAudio()
    } else {
      provider.reportCall(
        with: id, endedAt: Date(), reason: type == "connectionLost" ? .failed : .remoteEnded)
    }
    reset()
    emit(type)
  }

  private func reset() {
    callId = nil
    inApp = false
    connected = false
    closed = true
    VoiceAudioSessionOwner.agentCallActive = false
  }

  private func endInAppAudio() {
    let rtc = RTCAudioSession.sharedInstance()
    rtc.isAudioEnabled = false
    rtc.lockForConfiguration()
    try? rtc.setActive(false)
    rtc.unlockForConfiguration()
  }

  // MARK: WebRTC

  private func makeOffer() async throws -> String {
    let configuration = RTCConfiguration()
    configuration.sdpSemantics = .unifiedPlan
    configuration.bundlePolicy = .maxBundle
    configuration.rtcpMuxPolicy = .require
    let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
    guard
      let connection = Self.factory.peerConnection(
        with: configuration, constraints: constraints, delegate: self)
    else { throw MediaError.noConnection }
    self.connection = connection
    let audioConstraints = RTCMediaConstraints(
      mandatoryConstraints: nil,
      optionalConstraints: ["googEchoCancellation": "true", "googNoiseSuppression": "true"])
    let source = Self.factory.audioSource(with: audioConstraints)
    let track = Self.factory.audioTrack(with: source, trackId: "mic")
    self.track = track
    connection.add(track, streamIds: ["call"])
    dataChannel = connection.dataChannel(
      forLabel: "oai-events", configuration: RTCDataChannelConfiguration())
    dataChannel?.delegate = self
    let offerConstraints = RTCMediaConstraints(
      mandatoryConstraints: ["OfferToReceiveAudio": "true", "OfferToReceiveVideo": "false"],
      optionalConstraints: nil)
    let offer = try await connection.offer(for: offerConstraints)
    try await connection.setLocalDescription(offer)
    return offer.sdp
  }

  private func closeMedia() {
    dataChannel?.delegate = nil
    dataChannel?.close()
    connection?.close()
    dataChannel = nil
    connection = nil
    track = nil
  }

  enum MediaError: Error {
    case noConnection
  }

  private func peerConnected() {
    guard !closed, !connected, let callId else { return }
    connected = true
    if !inApp {
      provider.reportOutgoingCall(with: callId, connectedAt: Date())
    }
    emit("connected")
  }

  // MARK: Audio session

  private func watchAudioSession() {
    let center = NotificationCenter.default
    let session = AVAudioSession.sharedInstance()
    observers = [
      center.addObserver(
        forName: AVAudioSession.interruptionNotification, object: session, queue: .main
      ) { [weak self] note in
        let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
        let began = raw.flatMap(AVAudioSession.InterruptionType.init(rawValue:)) == .began
        MainActor.assumeIsolated { self?.interruption(began: began) }
      },
      center.addObserver(
        forName: AVAudioSession.routeChangeNotification, object: session, queue: .main
      ) { [weak self] note in
        let reason = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt ?? 0
        MainActor.assumeIsolated {
          guard let self, self.connected else { return }
          self.log.info("audio route changed, reason \(reason, privacy: .public)")
        }
      },
      center.addObserver(
        forName: AVAudioSession.mediaServicesWereResetNotification, object: session,
        queue: .main
      ) { [weak self] _ in
        MainActor.assumeIsolated {
          guard let self, self.connected else { return }
          self.log.notice("audio media services were reset")
          self.emit("interrupted")
          self.resumeAudio()
        }
      },
    ]
  }

  private func interruption(began: Bool) {
    guard connected else { return }
    log.notice("audio interruption \(began ? "began" : "ended", privacy: .public)")
    if began {
      emit("interrupted")
    } else {
      resumeAudio()
    }
  }

  /// Reactivates the session, retrying each second; Dart ends the call if
  /// audio never comes back.
  private func resumeAudio() {
    let id = callId
    Task { @MainActor [weak self] in
      for _ in 0..<6 {
        guard let self, self.callId == id, self.connected else { return }
        if Self.reactivateAudio() {
          self.log.notice("audio resumed after interruption")
          self.emit("resumed")
          return
        }
        try? await Task.sleep(nanoseconds: 1_000_000_000)
      }
      self?.log.error("audio didn't resume after interruption")
    }
  }

  nonisolated static func reactivateAudio() -> Bool {
    let rtc = RTCAudioSession.sharedInstance()
    rtc.lockForConfiguration()
    defer { rtc.unlockForConfiguration() }
    do {
      try rtc.setConfiguration(audioConfiguration(), active: true)
    } catch {
      return false
    }
    rtc.isAudioEnabled = false
    rtc.isAudioEnabled = true
    return true
  }

  /// `playAndRecord` in `voiceChat` mode (echo cancellation), on the
  /// speaker unless headphones or Bluetooth are connected.
  nonisolated static func audioConfiguration() -> RTCAudioSessionConfiguration {
    let configuration = RTCAudioSessionConfiguration.webRTC()
    configuration.category = AVAudioSession.Category.playAndRecord.rawValue
    configuration.mode = AVAudioSession.Mode.voiceChat.rawValue
    configuration.categoryOptions = [.defaultToSpeaker, .allowBluetoothHFP]
    return configuration
  }

  static func requestMicrophone() async -> Bool {
    if #available(iOS 17.0, *) {
      switch AVAudioApplication.shared.recordPermission {
      case .granted: return true
      case .denied: return false
      default: return await AVAudioApplication.requestRecordPermission()
      }
    }
    let session = AVAudioSession.sharedInstance()
    switch session.recordPermission {
    case .granted: return true
    case .denied: return false
    default:
      return await withCheckedContinuation { continuation in
        session.requestRecordPermission { continuation.resume(returning: $0) }
      }
    }
  }

  private func request(_ action: CXCallAction) async throws {
    let transaction = CXTransaction(action: action)
    try await withCheckedThrowingContinuation {
      (continuation: CheckedContinuation<Void, any Error>) in
      callController.request(transaction) { error in
        if let error {
          continuation.resume(throwing: error)
        } else {
          continuation.resume()
        }
      }
    }
  }

  // MARK: CXProviderDelegate (delivered on the main queue)

  nonisolated func providerDidReset(_ provider: CXProvider) {
    MainActor.assumeIsolated { self.endedRemotely("connectionLost") }
  }

  nonisolated func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
    // The category before CallKit activates the session.
    try? AVAudioSession.sharedInstance().setCategory(
      .playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP])
    action.fulfill()
  }

  nonisolated func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
    let uuid = action.callUUID
    MainActor.assumeIsolated {
      // The system's end button (or ours, after `end` already closed it).
      if self.callId == uuid, !self.closed {
        self.closeMedia()
        self.reset()
        self.emit("hangup")
      }
    }
    action.fulfill()
  }

  nonisolated func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
    let uuid = action.callUUID
    let muted = action.isMuted
    MainActor.assumeIsolated {
      guard self.callId == uuid else { return }
      self.track?.isEnabled = !muted
      self.emit("muted", ["muted": muted])
    }
    action.fulfill()
  }

  nonisolated func provider(_ provider: CXProvider, perform action: CXSetHeldCallAction) {
    action.fail()
  }

  nonisolated func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
    let rtc = RTCAudioSession.sharedInstance()
    rtc.audioSessionDidActivate(audioSession)
    rtc.lockForConfiguration()
    try? rtc.setConfiguration(Self.audioConfiguration())
    rtc.unlockForConfiguration()
    rtc.isAudioEnabled = true
    MainActor.assumeIsolated {
      if self.connected { self.emit("resumed") }
    }
  }

  nonisolated func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
    let rtc = RTCAudioSession.sharedInstance()
    rtc.audioSessionDidDeactivate(audioSession)
    rtc.isAudioEnabled = false
    MainActor.assumeIsolated {
      if self.connected, !self.closed {
        self.log.notice("audio session deactivated mid-call")
        self.emit("interrupted")
      }
    }
  }

  // MARK: RTCPeerConnectionDelegate

  nonisolated func peerConnection(
    _ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState
  ) {
    // Every event acts only for the call's current peer connection, never a
    // closed earlier one (a stale timer must not end a newer call).
    switch newState {
    case .connected:
      Task { @MainActor in
        guard peerConnection === self.connection else { return }
        self.peerConnected()
      }
    case .failed:
      Task { @MainActor in
        guard peerConnection === self.connection else { return }
        self.endedRemotely("connectionLost")
      }
    case .disconnected:
      // `disconnected` can recover; give it a few seconds.
      Task { @MainActor in
        try? await Task.sleep(nanoseconds: 5_000_000_000)
        guard peerConnection === self.connection,
          peerConnection.connectionState != .connected
        else { return }
        self.endedRemotely("connectionLost")
      }
    default:
      break
    }
  }

  nonisolated func peerConnection(
    _ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState
  ) {}
  nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream)
  {}
  nonisolated func peerConnection(
    _ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream
  ) {}
  nonisolated func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
  nonisolated func peerConnection(
    _ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState
  ) {}
  nonisolated func peerConnection(
    _ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState
  ) {}
  nonisolated func peerConnection(
    _ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate
  ) {}
  nonisolated func peerConnection(
    _ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]
  ) {}
  nonisolated func peerConnection(
    _ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel
  ) {}

  // MARK: RTCDataChannelDelegate

  nonisolated func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
    guard dataChannel.readyState == .closed else { return }
    Task { @MainActor in
      guard dataChannel === self.dataChannel else { return }
      self.endedRemotely("remoteClosed")
    }
  }

  /// Only the event type matters (`session.closed`); nothing from the
  /// channel is kept.
  nonisolated func dataChannel(
    _ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer
  ) {
    guard !buffer.isBinary,
      let event = try? JSONSerialization.jsonObject(with: buffer.data) as? [String: Any],
      event["type"] as? String == "session.closed"
    else { return }
    Task { @MainActor in
      guard dataChannel === self.dataChannel else { return }
      self.endedRemotely("remoteClosed")
    }
  }
}
