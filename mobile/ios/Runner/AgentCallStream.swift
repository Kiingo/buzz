import AVFoundation
import Foundation
import os

/// A Gemini agent call's media (Kiingo voice-provider-neutral §8–§10): the
/// `kiingo-voice-v1` stream socket and the audio, run by `AgentCallPlugin`
/// on the same CallKit call as a GPT-Live call.
///
/// - The offer is checked before anything opens: `wss`, the host exactly
///   the app's own API host (the call routes' origin, from the build, never
///   from the response) on its port, no userinfo, the path exactly
///   `/api/voice/calls/<this call>/stream`, no query or fragment, protocol
///   `kiingo-voice-v1`, a well-formed capability, pcm_s16le 16 kHz in and
///   24 kHz out.
/// - The capability goes only in `Sec-WebSocket-Protocol`
///   (`kiingo-cap.<capability>`); it is never logged, stored or shown. The
///   socket is an ephemeral session with no cookie, cache or credential
///   storage and no auth header, default TLS trust, redirects refused.
/// - Inbound is the server's fixed messages only, size-capped; nothing on
///   it runs a tool, opens a URL or sends anything but audio.
/// - Every stop closes the microphone and every socket.
///
/// Reconnects and handovers are Dart's (it reads stream-token, NIP-98
/// signed); this side opens what it is handed and reports what happened.

enum VoiceStreamRefusal: String, Error {
  case malformed = "offer_malformed"
  case scheme = "offer_scheme"
  case host = "offer_host"
  case path = "offer_path"
  case protocolName = "offer_protocol"
  case capability = "offer_capability"
  case format = "offer_format"
}

struct VoiceStreamOffer {
  static let protocolName = "kiingo-voice-v1"
  static let capabilityPrefix = "kiingo-cap."
  static let inputRate = 16_000
  static let outputRate = 24_000

  let url: URL
  let capability: String
  let maxBytesPerMessage: Int

  /// Checks a raw offer against the call and the app's API origin
  /// (`https://host[:port]`).
  static func validate(_ raw: Any?, callId: String, apiOrigin: String) throws
    -> VoiceStreamOffer
  {
    guard let record = raw as? [String: Any], let text = record["url"] as? String,
      let components = URLComponents(string: text), let url = components.url
    else { throw VoiceStreamRefusal.malformed }
    guard components.scheme?.lowercased() == "wss" else { throw VoiceStreamRefusal.scheme }
    guard let api = URLComponents(string: apiOrigin), api.scheme?.lowercased() == "https",
      let apiHost = api.host?.lowercased(), !apiHost.isEmpty,
      components.user == nil, components.password == nil,
      components.host?.lowercased() == apiHost,
      (components.port ?? 443) == (api.port ?? 443)
    else { throw VoiceStreamRefusal.host }
    guard callId.range(of: "^[A-Za-z0-9-]{1,64}$", options: .regularExpression) != nil,
      components.percentEncodedPath == "/api/voice/calls/\(callId)/stream",
      components.percentEncodedQuery == nil, components.fragment == nil,
      !text.contains("?"), !text.contains("#")
    else { throw VoiceStreamRefusal.path }
    guard record["protocol"] as? String == protocolName else {
      throw VoiceStreamRefusal.protocolName
    }
    guard let capability = record["capability"] as? String,
      capability.range(of: "^vsc1\\.[A-Za-z0-9_-]{20,128}$", options: .regularExpression) != nil
    else { throw VoiceStreamRefusal.capability }
    let input = record["input"] as? [String: Any]
    let output = record["output"] as? [String: Any]
    guard input?["encoding"] as? String == "pcm_s16le",
      (input?["sampleRateHz"] as? NSNumber)?.intValue == inputRate,
      input?["channels"] == nil || (input?["channels"] as? NSNumber)?.intValue == 1,
      output?["encoding"] as? String == "pcm_s16le",
      (output?["sampleRateHz"] as? NSNumber)?.intValue == outputRate,
      output?["channels"] == nil || (output?["channels"] as? NSNumber)?.intValue == 1
    else { throw VoiceStreamRefusal.format }
    let declared = (input?["maxBytesPerMessage"] as? NSNumber)?.intValue ?? 32_000
    return VoiceStreamOffer(
      url: url, capability: capability,
      maxBytesPerMessage: declared >= 1_280 ? min(declared, 32_000) : 32_000)
  }
}

/// One stream socket. Delegate callbacks arrive on the main queue.
@MainActor
final class VoiceStreamSocket {
  enum Event {
    case opened(protocolName: String?)
    case text(String)
    case closed(code: Int)
  }

  /// Inbound frames above this are dropped unread.
  static let maxInboundCharacters = 256 * 1024

  private var session: URLSession?
  private var task: URLSessionWebSocketTask?
  private let onEvent: (VoiceStreamSocket, Event) -> Void
  var started = false
  var lastHeard = Date()
  private var closed = false

  init(offer: VoiceStreamOffer, onEvent: @escaping (VoiceStreamSocket, Event) -> Void) {
    self.onEvent = onEvent
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.urlCredentialStorage = nil
    configuration.urlCache = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.timeoutIntervalForRequest = 15
    let delegate = VoiceStreamSocketDelegate()
    let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: .main)
    let task = session.webSocketTask(
      with: offer.url,
      protocols: [VoiceStreamOffer.protocolName, VoiceStreamOffer.capabilityPrefix + offer.capability])
    task.maximumMessageSize = Self.maxInboundCharacters + 1_024
    self.session = session
    self.task = task
    delegate.owner = self
    task.resume()
    receive()
  }

  private func receive() {
    task?.receive { [weak self] result in
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          guard let self, !self.closed else { return }
          switch result {
          case .success(.string(let text)):
            self.lastHeard = Date()
            if text.count <= Self.maxInboundCharacters { self.onEvent(self, .text(text)) }
            self.receive()
          case .success:
            // Binary frames are not part of the protocol: ignored.
            self.lastHeard = Date()
            self.receive()
          case .failure:
            self.didClose(code: self.task?.closeCode.rawValue ?? 1006)
          }
        }
      }
    }
  }

  fileprivate func didOpen(protocolName: String?) {
    guard !closed else { return }
    lastHeard = Date()
    onEvent(self, .opened(protocolName: protocolName))
  }

  fileprivate func didClose(code: Int) {
    guard !closed else { return }
    close(code: 1000)
    onEvent(self, .closed(code: code == 0 ? 1006 : code))
  }

  func send(_ message: [String: Any]) {
    guard !closed, let task,
      let data = try? JSONSerialization.data(withJSONObject: message),
      let text = String(data: data, encoding: .utf8)
    else { return }
    task.send(.string(text)) { _ in }
  }

  /// Closes the socket and drops the session (and with it the handshake
  /// request that carried the capability). Reports nothing.
  func close(code: Int) {
    guard !closed else { return }
    closed = true
    task?.cancel(with: URLSessionWebSocketTask.CloseCode(rawValue: code) ?? .normalClosure, reason: nil)
    session?.invalidateAndCancel()
    task = nil
    session = nil
  }
}

private final class VoiceStreamSocketDelegate: NSObject, URLSessionWebSocketDelegate {
  weak var owner: VoiceStreamSocket?

  func urlSession(
    _ session: URLSession, webSocketTask: URLSessionWebSocketTask,
    didOpenWithProtocol protocol: String?
  ) {
    MainActor.assumeIsolated { owner?.didOpen(protocolName: `protocol`) }
  }

  func urlSession(
    _ session: URLSession, webSocketTask: URLSessionWebSocketTask,
    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?
  ) {
    MainActor.assumeIsolated { owner?.didClose(code: closeCode.rawValue) }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    MainActor.assumeIsolated { owner?.didClose(code: 1006) }
  }

  /// Redirects are refused: the socket goes only to the checked URL.
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }
}

/// `AVAudioEngine` with voice processing on the input (echo cancellation),
/// capture converted to 16 kHz mono s16le in 40 ms frames, and 24 kHz
/// playback through a player node, never more than 8 s ahead. CallKit owns
/// and activates the session; this starts once it is active.
final class VoiceStreamEngine: @unchecked Sendable {
  static let frameBytes = VoiceStreamOffer.inputRate / 25 * 2
  static let maxScheduledFrames = VoiceStreamOffer.outputRate * 8

  private let engine = AVAudioEngine()
  private let player = AVAudioPlayerNode()
  private let playFormat = AVAudioFormat(
    commonFormat: .pcmFormatFloat32, sampleRate: Double(VoiceStreamOffer.outputRate),
    channels: 1, interleaved: false)!
  private let sendFormat = AVAudioFormat(
    commonFormat: .pcmFormatInt16, sampleRate: Double(VoiceStreamOffer.inputRate), channels: 1,
    interleaved: true)!

  // `lock` guards everything below (main thread and the tap's thread).
  private let lock = NSLock()
  private var running = false
  private var touchedInput = false
  private var attached = false
  private var scheduledFrames = 0
  private var generation = 0
  private var pending = Data()
  private var onFrame: ((Data) -> Void)?

  var isRunning: Bool { lock.withLock { running } && engine.isRunning }

  /// Starts capture and playback; `onFrame` gets 40 ms frames on the main
  /// thread.
  func start(onFrame: @escaping (Data) -> Void) throws {
    guard !isRunning else { return }
    lock.withLock {
      self.onFrame = onFrame
      touchedInput = true
      pending = Data()
    }
    let input = engine.inputNode
    if !input.isVoiceProcessingEnabled { try input.setVoiceProcessingEnabled(true) }
    if !lock.withLock({ attached }) {
      engine.attach(player)
      lock.withLock { attached = true }
    }
    engine.connect(player, to: engine.mainMixerNode, format: playFormat)
    let inputFormat = input.outputFormat(forBus: 0)
    guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0,
      let converter = AVAudioConverter(from: inputFormat, to: sendFormat)
    else { throw VoiceStreamEngineError.noInput }
    let sendFormat = sendFormat
    input.removeTap(onBus: 0)
    input.installTap(onBus: 0, bufferSize: 1_024, format: inputFormat) { [weak self] buffer, _ in
      guard let self, let bytes = Self.convert(buffer, with: converter, to: sendFormat) else {
        return
      }
      self.capture(bytes)
    }
    engine.prepare()
    do {
      try engine.start()
    } catch {
      input.removeTap(onBus: 0)
      throw error
    }
    player.play()
    lock.withLock { running = true }
  }

  private func capture(_ bytes: Data) {
    var frames: [Data] = []
    let deliver = lock.withLock { () -> ((Data) -> Void)? in
      pending.append(bytes)
      while pending.count >= Self.frameBytes {
        frames.append(pending.prefix(Self.frameBytes))
        pending.removeFirst(Self.frameBytes)
      }
      return running ? onFrame : nil
    }
    guard let deliver, !frames.isEmpty else { return }
    DispatchQueue.main.async {
      for frame in frames { deliver(Data(frame)) }
    }
  }

  private static func convert(
    _ buffer: AVAudioPCMBuffer, with converter: AVAudioConverter, to format: AVAudioFormat
  ) -> Data? {
    let ratio = format.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
    guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else {
      return nil
    }
    var handed = false
    var error: NSError?
    let status = converter.convert(to: output, error: &error) { _, outStatus in
      if handed {
        outStatus.pointee = .noDataNow
        return nil
      }
      handed = true
      outStatus.pointee = .haveData
      return buffer
    }
    guard status != .error, error == nil, output.frameLength > 0,
      let samples = output.int16ChannelData
    else { return nil }
    return Data(bytes: samples[0], count: Int(output.frameLength) * 2)
  }

  /// Schedules 24 kHz s16le bytes after what's queued; refused past 8 s.
  func play(_ pcm: Data) {
    guard isRunning else { return }
    let frames = pcm.count / 2
    guard frames > 0,
      let buffer = AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: AVAudioFrameCount(frames)),
      let channel = buffer.floatChannelData?[0]
    else { return }
    buffer.frameLength = AVAudioFrameCount(frames)
    pcm.withUnsafeBytes { raw in
      for index in 0..<frames {
        let lo = UInt16(raw[2 * index])
        let hi = UInt16(raw[2 * index + 1])
        channel[index] = Float(Int16(bitPattern: lo | (hi << 8))) / 32_768
      }
    }
    let generation = lock.withLock { () -> Int? in
      guard scheduledFrames + frames <= Self.maxScheduledFrames else { return nil }
      scheduledFrames += frames
      return self.generation
    }
    guard let generation else { return }
    player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
      guard let self else { return }
      self.lock.withLock {
        if self.generation == generation {
          self.scheduledFrames = max(0, self.scheduledFrames - frames)
        }
      }
    }
  }

  /// Drops everything scheduled (barge-in).
  func flush() {
    lock.withLock {
      generation += 1
      scheduledFrames = 0
    }
    guard isRunning else { return }
    player.stop()
    player.play()
  }

  /// Stops capture and playback and gives the voice-processing input back
  /// (the microphone closes).
  func stop() {
    let touched = lock.withLock { () -> Bool in
      running = false
      generation += 1
      scheduledFrames = 0
      pending = Data()
      onFrame = nil
      return touchedInput
    }
    guard touched else { return }
    engine.inputNode.removeTap(onBus: 0)
    player.stop()
    engine.stop()
    if engine.inputNode.isVoiceProcessingEnabled {
      try? engine.inputNode.setVoiceProcessingEnabled(false)
    }
  }
}

enum VoiceStreamEngineError: Error {
  case noInput
}

/// One Gemini call's sockets and audio. Events go to `emit` (codes only).
@MainActor
final class AgentCallStream {
  /// A socket that says nothing this long is treated as dropped.
  static let staleAfter: TimeInterval = 45
  static let pingEvery: TimeInterval = 15

  let callId: String
  private let apiOrigin: String
  private let emit: (String, [String: Any]) -> Void
  private let log = Logger(subsystem: "buzz", category: "agent-call-stream")
  private let audio = VoiceStreamEngine()
  private var current: VoiceStreamSocket?
  private var pending: VoiceStreamSocket?
  private var pingTimer: Timer?
  private var muted = false
  private var everStarted = false
  private var ended = false
  private var sessionActive = false

  init(callId: String, apiOrigin: String, emit: @escaping (String, [String: Any]) -> Void) {
    self.callId = callId
    self.apiOrigin = apiOrigin
    self.emit = emit
    pingTimer = Timer.scheduledTimer(withTimeInterval: Self.pingEvery, repeats: true) {
      [weak self] _ in
      MainActor.assumeIsolated { self?.keepAlive() }
    }
  }

  /// Opens a socket for a checked offer: `current` replaces the current one
  /// (a reconnect), `pending` opens beside it (a planned handover).
  func connect(_ raw: Any?, pendingRole: Bool) throws {
    guard !ended else { throw VoiceStreamRefusal.malformed }
    let offer = try VoiceStreamOffer.validate(raw, callId: callId, apiOrigin: apiOrigin)
    let socket = VoiceStreamSocket(offer: offer) { [weak self] socket, event in
      self?.handle(socket, event)
    }
    if pendingRole, current != nil {
      pending?.close(code: 1000)
      pending = socket
    } else {
      current?.close(code: 1000)
      current = socket
    }
  }

  /// The audio session is active (CallKit, or the app's own): start audio.
  /// Returns false when it couldn't start.
  @discardableResult
  func audioSessionActivated() -> Bool {
    sessionActive = true
    guard !ended else { return true }
    do {
      try audio.start { [weak self] frame in
        MainActor.assumeIsolated { self?.sendFrame(frame) }
      }
      return true
    } catch {
      log.error("stream audio didn't start")
      return false
    }
  }

  func audioSessionDeactivated() {
    sessionActive = false
    audio.stop()
  }

  var hasActiveSession: Bool { sessionActive }

  func setMuted(_ muted: Bool) {
    if muted, !self.muted, let current, current.started {
      current.send(["type": "audio_stream_end"])
    }
    self.muted = muted
  }

  /// Closes every socket and the microphone. Reports nothing.
  func stop() {
    ended = true
    pingTimer?.invalidate()
    pingTimer = nil
    pending?.close(code: 1000)
    current?.close(code: 1000)
    pending = nil
    current = nil
    audio.stop()
  }

  private func sendFrame(_ frame: Data) {
    guard !ended, !muted, let current, current.started else { return }
    current.send(["type": "audio", "data": frame.base64EncodedString()])
  }

  private func keepAlive() {
    guard !ended, let socket = current, socket.started else { return }
    if Date().timeIntervalSince(socket.lastHeard) > Self.staleAfter {
      socket.close(code: 4000)
      closed(socket, code: 4000)
      return
    }
    socket.send(["type": "ping", "t": Int(Date().timeIntervalSince1970 * 1000)])
  }

  private func handle(_ socket: VoiceStreamSocket, _ event: VoiceStreamSocket.Event) {
    guard !ended else { return }
    switch event {
    case .opened(let protocolName):
      if protocolName != VoiceStreamOffer.protocolName {
        socket.close(code: 1002)
        closed(socket, code: 1002)
      }
    case .text(let text):
      message(socket, text)
    case .closed(let code):
      closed(socket, code: code)
    }
  }

  private func message(_ socket: VoiceStreamSocket, _ text: String) {
    guard let data = text.data(using: .utf8),
      let record = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let type = record["type"] as? String
    else { return }
    switch type {
    case "session.started":
      guard !socket.started else { return }
      socket.started = true
      if socket === pending {
        // Make before break: the new socket took over.
        let old = current
        current = socket
        pending = nil
        old?.close(code: 1000)
        emit("streamResumed", [:])
      } else if socket === current {
        emit(everStarted ? "streamResumed" : "streamStarted", [:])
      }
      everStarted = true
      if muted { socket.send(["type": "audio_stream_end"]) }
    case "audio.delta":
      guard socket === current, let encoded = record["data"] as? String,
        encoded.count % 4 == 0, let pcm = Data(base64Encoded: encoded)
      else { return }
      audio.play(pcm)
    case "audio.interrupted":
      if socket === current { audio.flush() }
    case "session.reconnect":
      // The embedded offer is never used: Dart asks stream-token.
      if socket === current { emit("streamHandover", [:]) }
    case "session.closed":
      if socket === current || socket === pending { emit("streamClosed", [:]) }
    default:
      // pong, captions: nothing to do here (the call feed carries them).
      return
    }
  }

  private func closed(_ socket: VoiceStreamSocket, code: Int) {
    guard !ended else { return }
    if socket === pending {
      pending = nil
      emit("streamHandoverFailed", ["code": code])
      if current == nil { emit("streamLost", ["code": code]) }
      return
    }
    guard socket === current else { return }
    current = nil
    if pending != nil { return }
    if code == 4009, everStarted {
      emit("streamReplaced", [:])
      return
    }
    emit("streamLost", ["code": code])
  }
}
