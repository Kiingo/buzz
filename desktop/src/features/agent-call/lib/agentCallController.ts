import { invokeTauri } from "@/shared/api/tauri";
import { isMacPlatform } from "@/shared/lib/platform";

import {
  type StartAgentCallResponse,
  describeAgentCallError,
  endAgentCall,
  getAgentCall,
  getAgentCallFeed,
  getAgentCallStreamHost,
  getAgentCallStreamToken,
  isProviderUnavailableError,
  startAgentCall,
  stopAgentCallWork,
} from "./agentCallApi";
import {
  VOICE_STREAM_CLIENT_CAPABILITY,
  VOICE_STREAM_MIC_CONSTRAINTS,
  VoiceStreamPlayback,
  VoiceStreamSession,
  canRunVoiceStream,
  createVoiceStreamAudioContext,
  parseVoiceStreamOffer,
  startVoiceStreamCapture,
  type VoiceProviderId,
  type VoiceStartProvider,
  type VoiceStreamCapture,
  type VoiceStreamOffer,
  type VoiceStreamSessionEvent,
} from "./voice-stream";
import {
  type AgentCallFeed,
  feedWantsMore,
  isFeedSnapshot,
} from "./agentCallFeed";

/**
 * The app's one live 1:1 agent call (the host allows one per person).
 *
 * Ported from the agent host's web dashboard call controller so desktop calls
 * behave like the phone and web calls of the same voice core: this module
 * captures the mic, makes the WebRTC SDP offer, has the host answer it from
 * the caller's private DM with the agent, and applies the answer. Audio then
 * runs between this webview and the host's realtime voice provider. It lives
 * outside React so a call survives changing channel; components read it
 * through `useAgentCall`.
 *
 * Differences from the web dashboard: the call starts from a DM (agent key +
 * channel id), and the call screen follows the host's feed long-poll
 * (`GET calls/:id/feed?rev&wait=20`, backing off 1 s → 15 s on errors)
 * instead of a 1.5 s status poll. After hang-up the feed is followed until
 * the recap is written (at most 90 s) and the screen keeps it until closed.
 *
 * Voice provider (Kiingo docs/design/voice-provider-neutral.md): GPT-Live
 * over WebRTC as above, or Gemini over the host's `kiingo-voice-v1` stream
 * socket (`./voice-stream`, vendored from Kiingo's shared client). The
 * provider is chosen at call start and fixed for the call; the feed, Stop,
 * answers and hang-up are the same on both. Gemini runs on macOS only (the
 * Windows app is frozen): elsewhere `gemini_ws` is never advertised.
 *
 * Hang-up ends the call only. It never cancels the agent's work; its answers
 * land in the DM. Stop does that, through the host's stop control.
 *
 * One audio owner: a call never runs beside a huddle. A call refuses to start
 * while a huddle is active or starting (checked before and again after the
 * mic opens), and a huddle refuses to start or join while a call is busy
 * (`assertNoAgentCallForHuddle`). Otherwise huddle members would be heard as
 * the caller's asks and the agent's voice would play into the room.
 */

export type AgentCallPhase =
  | "idle"
  | "requesting_mic"
  | "connecting"
  | "live"
  | "ending"
  | "ended"
  | "error";

export type AgentCallClientErrorKind =
  | "request_failed"
  | "mic_denied"
  | "mic_unavailable"
  | "unsupported"
  | "huddle_active"
  | "provider_unavailable"
  | "connection_failed";

/** What the call screen says about its voice. */
export type AgentCallProvider = Pick<
  VoiceStartProvider,
  "id" | "source" | "fallbackFrom" | "fallbackReason"
>;

export type AgentCallEndReason =
  | "hangup"
  | "time_limit"
  | "remote"
  | "connection_lost"
  | "community_changed";

export type AgentCallStopState =
  | { status: "idle" }
  | { status: "stopping" }
  | { status: "stopped" }
  | { status: "nothing_to_stop" }
  | { status: "failed"; message: string };

export type AgentCallState = {
  phase: AgentCallPhase;
  agentPubkey: string | null;
  agentName: string | null;
  channelId: string | null;
  callId: string | null;
  /** Epoch ms when audio connected; the live timer counts from here. */
  connectedAt: number | null;
  endedAt: number | null;
  executeUntil: string | null;
  muted: boolean;
  stop: AgentCallStopState;
  error: { kind: AgentCallClientErrorKind; message: string } | null;
  /** The explicit one-tap choice this call was placed with, if any. */
  requestedProvider: VoiceProviderId | null;
  /** After a failed explicit pick: the provider the error offers instead. */
  retryWith: VoiceProviderId | null;
  /** The call's voice; null before the host answers (or an older host). */
  provider: AgentCallProvider | null;
  /** A Gemini stream dropped and is reconnecting. */
  reconnecting: boolean;
  endReason: AgentCallEndReason | null;
  /** The host's call screen feed (latest snapshot), or null before it. */
  feed: AgentCallFeed | null;
};

const IDLE: AgentCallState = {
  phase: "idle",
  agentPubkey: null,
  agentName: null,
  channelId: null,
  callId: null,
  connectedAt: null,
  endedAt: null,
  executeUntil: null,
  muted: false,
  stop: { status: "idle" },
  error: null,
  requestedProvider: null,
  retryWith: null,
  provider: null,
  reconnecting: false,
  endReason: null,
  feed: null,
};

/** How long a `disconnected` peer may take to recover before the call ends. */
const DISCONNECT_GRACE_MS = 5_000;
/** How long "Call ended" stays when the call had nothing on its screen. */
const ENDED_DISMISS_MS = 4_000;
const STOP_STATUS_RESET_MS = 4_000;
/** The feed long-poll's wait, and how long it is followed after hang-up. */
const FEED_WAIT_S = 20;
const FEED_AFTER_END_MS = 90_000;
/** How long a call may stay connecting before it ends as `media_failed`. */
const CONNECT_TIMEOUT_MS = 20_000;
const HUDDLE_ACTIVE_MESSAGE =
  "You're in a huddle. Leave it to call your agent.";
const HUDDLE_UNKNOWN_MESSAGE =
  "Buzz couldn't check whether a huddle is using the microphone, so the call didn't start. Try again.";

export function feedRetryDelay(failures: number): number {
  return Math.min(15_000, 1_000 * 2 ** Math.max(0, failures - 1));
}

type Transport = {
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createPeerConnection: () => RTCPeerConnection;
  createAudioElement: () => HTMLAudioElement;
  startCall: typeof startAgentCall;
  endCall: typeof endAgentCall;
  stopWork: typeof stopAgentCallWork;
  getFeed: typeof getAgentCallFeed;
  isSupported: () => boolean;
  /** Whether a huddle holds (or is taking) the mic in this app. */
  isHuddleActive: () => Promise<boolean>;
  /** This app runs Gemini's stream transport (macOS only). */
  canStream: () => boolean;
  createAudioContext: () => AudioContext | null;
  getStreamToken: typeof getAgentCallStreamToken;
  getStreamHost: typeof getAgentCallStreamHost;
  getCall: typeof getAgentCall;
  connectTimeoutMs: number;
  now: () => number;
};

let huddleAudioProbe: (() => boolean) | null = null;

/**
 * The huddle provider that owns the app's audio session registers how to tell
 * whether a huddle is active or starting. Returns the unregister function.
 */
export function registerHuddleAudioProbe(probe: () => boolean): () => void {
  huddleAudioProbe = probe;
  return () => {
    if (huddleAudioProbe === probe) huddleAudioProbe = null;
  };
}

/**
 * The registered probe, then the native huddle state (any window's huddle).
 * Throws when the native state can't be read; the call then refuses.
 */
async function webviewHuddleActive(): Promise<boolean> {
  if (huddleAudioProbe?.()) return true;
  const state = await invokeTauri<{ phase?: unknown } | null>(
    "get_huddle_state",
  );
  if (typeof state?.phase !== "string") {
    throw new Error("huddle_state_unreadable");
  }
  return state.phase !== "idle";
}

/**
 * Whether this app may offer and run Gemini calls: macOS only (Windows is
 * frozen and Linux is untested), with Web Audio worklets and WebSockets.
 */
export function canRunAgentCallStream(): boolean {
  return isMacPlatform() && canRunVoiceStream();
}

/** Whether this webview can place a call at all (WebRTC and a mic API). */
export function isAgentCallSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof RTCPeerConnection !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  );
}

const webviewTransport = (): Transport => ({
  getUserMedia: (constraints) =>
    navigator.mediaDevices.getUserMedia(constraints),
  createPeerConnection: () => new RTCPeerConnection(),
  createAudioElement: () => {
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.setAttribute("playsinline", "");
    audio.setAttribute("data-agent-call-audio", "");
    audio.style.display = "none";
    document.body.appendChild(audio);
    return audio;
  },
  startCall: startAgentCall,
  endCall: endAgentCall,
  stopWork: stopAgentCallWork,
  getFeed: getAgentCallFeed,
  isSupported: isAgentCallSupported,
  isHuddleActive: webviewHuddleActive,
  canStream: canRunAgentCallStream,
  createAudioContext: createVoiceStreamAudioContext,
  getStreamToken: getAgentCallStreamToken,
  getStreamHost: getAgentCallStreamHost,
  getCall: getAgentCall,
  connectTimeoutMs: CONNECT_TIMEOUT_MS,
  now: () => Date.now(),
});

function stopTracks(stream: MediaStream) {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

function describeMicError(error: unknown): {
  kind: AgentCallClientErrorKind;
  message: string;
} {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return {
      kind: "mic_denied",
      message:
        "Microphone access is off for this app. Allow it in System Settings → Privacy & Security → Microphone, then call again.",
    };
  }
  if (
    name === "NotFoundError" ||
    name === "NotReadableError" ||
    name === "OverconstrainedError" ||
    name === "AbortError"
  ) {
    return {
      kind: "mic_unavailable",
      message:
        "No microphone is available. Connect one or close other apps using it, then call again.",
    };
  }
  return {
    kind: "mic_unavailable",
    message: "The microphone couldn't start. Try again.",
  };
}

export class AgentCallController {
  private state: AgentCallState = IDLE;
  private readonly listeners = new Set<() => void>();
  private readonly transport: Transport;
  private attempt = 0;
  /** Bumped to stop the feed loop (dismiss, a new call, a community switch). */
  private feedToken = 0;
  private feedUntil: number | null = null;
  private stream: MediaStream | null = null;
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private audio: HTMLAudioElement | null = null;
  private audioContext: AudioContext | null = null;
  private streamSession: VoiceStreamSession | null = null;
  private capture: VoiceStreamCapture | null = null;
  private playback: VoiceStreamPlayback | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** The attempt the connect timeout ended, so its late answer ends as such. */
  private timedOutAttempt = 0;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(transport?: Partial<Transport>) {
    this.transport = {
      connectTimeoutMs: CONNECT_TIMEOUT_MS,
      // Without a webview (tests), no Gemini stream unless given one.
      canStream: () => false,
      createAudioContext: () => null,
      ...(typeof window !== "undefined" ? webviewTransport() : {}),
      ...transport,
    } as Transport;
  }

  getState = (): AgentCallState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private set(patch: Partial<AgentCallState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) {
      listener();
    }
  }

  private later(callback: () => void, ms: number) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      callback();
    }, ms);
    this.timers.add(timer);
    return timer;
  }

  get isBusy(): boolean {
    return (
      this.state.phase === "requesting_mic" ||
      this.state.phase === "connecting" ||
      this.state.phase === "live" ||
      this.state.phase === "ending"
    );
  }

  /** Starts a call from the caller's 1:1 DM with the agent. Run it from the
   * click handler, so playback and the mic open inside the gesture. */
  start = async (input: {
    agentPubkey: string;
    channelId: string;
    agentName?: string | null;
    /** The one-tap choice (explicit: never changes silently). */
    provider?: VoiceProviderId | null;
    /** What a start without a choice is expected to get (settings `effective`). */
    expectedProvider?: VoiceProviderId | null;
  }) => {
    if (this.isBusy) {
      return;
    }
    const choice = input.provider ?? null;
    const canStream = this.transport.canStream();
    // No choice: the host resolves, with an offer in case it's GPT-Live.
    const needsOffer = choice !== "gemini";
    const mayStream =
      canStream &&
      (choice === "gemini" ||
        (choice === null && input.expectedProvider !== "gpt-live"));
    this.clearTimers();
    this.feedToken++;
    const attempt = ++this.attempt;
    const tapAt = new Date(this.transport.now()).toISOString();
    this.set({
      ...IDLE,
      phase: "requesting_mic",
      agentPubkey: input.agentPubkey,
      agentName: input.agentName ?? null,
      channelId: input.channelId,
      requestedProvider: choice,
    });
    if (choice === "gemini" && !canStream) {
      this.fail(
        {
          kind: "provider_unavailable",
          message: "This version of the app can't run Gemini calls.",
        },
        "gpt-live",
      );
      return;
    }
    if (!this.transport.isSupported()) {
      this.fail({
        kind: "unsupported",
        message: "Calls aren't available in this version of the app.",
      });
      return;
    }
    // Unlock playback inside the gesture; the stream is attached later.
    this.audio = this.transport.createAudioElement();
    void this.audio.play().catch(() => undefined);
    // Gemini plays through Web Audio: its context starts inside the gesture.
    if (mayStream) {
      this.audioContext = this.transport.createAudioContext();
    }
    if (await this.abandonForHuddle(attempt)) {
      return;
    }

    let stream: MediaStream;
    try {
      stream = await this.transport.getUserMedia(VOICE_STREAM_MIC_CONSTRAINTS);
    } catch (error) {
      if (attempt === this.attempt) {
        this.fail(describeMicError(error));
      }
      return;
    }
    if (attempt !== this.attempt) {
      // Superseded while the mic opened: close only this attempt's stream.
      stopTracks(stream);
      return;
    }
    this.stream = stream;
    // A huddle may have started while the mic permission was pending.
    if (await this.abandonForHuddle(attempt)) {
      return;
    }
    this.set({ phase: "connecting" });
    this.connectTimer = this.later(
      () => this.onConnectTimeout(attempt),
      this.transport.connectTimeoutMs,
    );

    let peer: RTCPeerConnection | null = null;
    let offerSdp: string | null = null;
    if (needsOffer) {
      try {
        peer = this.transport.createPeerConnection();
        this.peer = peer;
        for (const track of stream.getAudioTracks()) {
          peer.addTrack(track, stream);
        }
        peer.ontrack = (event) => {
          if (!this.audio) {
            return;
          }
          this.audio.srcObject =
            event.streams[0] ?? new MediaStream([event.track]);
          void this.audio.play().catch(() => undefined);
        };
        peer.onconnectionstatechange = () => this.onPeerState(attempt);
        this.channel = peer.createDataChannel("oai-events");
        this.channel.onmessage = (event) => this.onChannelMessage(event.data);
        this.channel.onclose = () => {
          if (attempt === this.attempt && this.state.phase === "live") {
            void this.finish("remote");
          }
        };
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        offerSdp = offer.sdp ?? "";
        if (!offerSdp) {
          throw new Error("empty_offer");
        }
      } catch {
        if (attempt === this.attempt) {
          this.fail({
            kind: "connection_failed",
            message: "The call couldn't be set up. Try again.",
          });
        }
        return;
      }
      if (attempt !== this.attempt) {
        // Hung up while the offer was made: never ask the host to answer it.
        if (peer && this.peer !== peer) {
          try {
            peer.close();
          } catch {
            // Already closed.
          }
        }
        return;
      }
    }

    let response: StartAgentCallResponse;
    try {
      response = await this.transport.startCall({
        agentPubkey: input.agentPubkey,
        channelId: input.channelId,
        ...(offerSdp ? { sdpOffer: offerSdp } : {}),
        ...(choice ? { provider: choice } : {}),
        ...(canStream
          ? { clientCapabilities: [VOICE_STREAM_CLIENT_CAPABILITY] }
          : {}),
        clientTapAt: tapAt,
      });
    } catch (error) {
      if (attempt === this.attempt) {
        const unavailable = isProviderUnavailableError(error);
        // An explicit pick that fails offers the default (as on the phone).
        this.fail(
          {
            kind: unavailable ? "provider_unavailable" : "request_failed",
            message: describeAgentCallError(error),
          },
          unavailable && choice === "gemini" ? "gpt-live" : null,
        );
      }
      return;
    }
    if (attempt !== this.attempt) {
      // Hung up (or timed out) while the host was answering: end the call it
      // opened.
      const reason =
        this.timedOutAttempt === attempt ? "media_failed" : "hangup";
      void this.transport
        .endCall(response.callId, reason)
        .catch(() => undefined);
      return;
    }
    this.set({
      callId: response.callId,
      executeUntil: response.executeUntil,
      provider: response.provider
        ? {
            id: response.provider.id,
            source: response.provider.source,
            fallbackFrom: response.provider.fallbackFrom,
            fallbackReason: response.provider.fallbackReason,
          }
        : {
            id: response.transport === "gemini_ws" ? "gemini" : "gpt-live",
            source: "system",
            fallbackFrom: null,
            fallbackReason: null,
          },
    });
    this.followFeed(response.callId);

    if (response.transport === "gemini_ws") {
      if (choice === "gpt-live" || !canStream) {
        // Never a voice the caller didn't pick, nor one this app can't run.
        void this.transport
          .endCall(response.callId, "media_failed")
          .catch(() => undefined);
        this.fail({
          kind: "connection_failed",
          message: "The call couldn't start with that voice. Try again.",
        });
        return;
      }
      this.releasePeer();
      await this.startStream(attempt, response.callId, response.stream);
      return;
    }
    this.closeAudioContext();
    if (!this.peer) {
      void this.transport
        .endCall(response.callId, "media_failed")
        .catch(() => undefined);
      this.fail({
        kind: "connection_failed",
        message: "The call couldn't be set up. Try again.",
      });
      return;
    }

    try {
      await this.peer?.setRemoteDescription({
        type: "answer",
        sdp: response.sdpAnswer,
      });
    } catch {
      if (attempt === this.attempt) {
        void this.transport
          .endCall(response.callId, "media_failed")
          .catch(() => undefined);
        this.fail({
          kind: "connection_failed",
          message: "The call connected but audio couldn't start. Try again.",
        });
      }
      return;
    }
    this.scheduleLimit(attempt, response.executeUntil);
  };

  /** Gemini: the checked offer, capture, playback, then the socket. */
  private async startStream(attempt: number, callId: string, raw: unknown) {
    const abandon = (message: string) => {
      void this.transport
        .endCall(callId, "media_failed")
        .catch(() => undefined);
      this.fail({ kind: "connection_failed", message });
    };
    const host = await this.transport.getStreamHost();
    if (attempt !== this.attempt) {
      return;
    }
    const parse = (value: unknown): VoiceStreamOffer =>
      parseVoiceStreamOffer(value, {
        callId,
        apiHosts: host ? [host] : [],
      });
    let offer: VoiceStreamOffer;
    try {
      offer = parse(raw);
    } catch {
      abandon(
        "The call's audio link didn't look right, so it wasn't opened. Try again.",
      );
      return;
    }
    const context = this.audioContext ?? this.transport.createAudioContext();
    this.audioContext = context;
    if (!context || !this.stream) {
      abandon("This version of the app can't play Gemini audio.");
      return;
    }
    void context.resume().catch(() => undefined);
    const playback = new VoiceStreamPlayback({
      context,
      audioElement: this.audio,
    });
    this.playback = playback;
    try {
      const [capture] = await Promise.all([
        startVoiceStreamCapture({
          context,
          stream: this.stream,
          onFrame: (pcm) => this.streamSession?.sendAudio(pcm),
        }),
        playback.attach(),
      ]);
      if (attempt !== this.attempt) {
        capture.stop();
        return;
      }
      this.capture = capture;
    } catch {
      if (attempt === this.attempt) {
        abandon("The microphone couldn't start for this call. Try again.");
      }
      return;
    }
    const session = new VoiceStreamSession({
      offer,
      refreshOffer: async () =>
        parse(await this.transport.getStreamToken(callId)),
      isCallEnded: async () => {
        const view = await this.transport.getCall(callId);
        return (
          Boolean(view) &&
          typeof view === "object" &&
          (view as { state?: unknown }).state === "ended"
        );
      },
      onAudio: (pcm) => {
        playback.enqueue(pcm);
      },
      onInterrupted: () => playback.flush(),
      onEvent: (event) => this.onStreamEvent(attempt, event),
    });
    this.streamSession = session;
    session.setMuted(this.state.muted);
    await session.start();
    this.scheduleLimit(attempt, this.state.executeUntil);
  }

  private onStreamEvent(attempt: number, event: VoiceStreamSessionEvent) {
    if (attempt !== this.attempt) {
      return;
    }
    switch (event.type) {
      case "started":
        if (this.state.phase === "connecting") {
          if (this.connectTimer) {
            clearTimeout(this.connectTimer);
            this.timers.delete(this.connectTimer);
            this.connectTimer = null;
          }
          this.set({ phase: "live", connectedAt: this.transport.now() });
        }
        return;
      case "reconnecting":
        this.set({ reconnecting: true });
        return;
      case "resumed":
        this.set({ reconnecting: false });
        return;
      case "first_audio":
      case "input_transcript":
      case "output_transcript":
        // Captions come from the feed, as on GPT-Live.
        return;
      case "ended":
        if (this.state.phase === "connecting") {
          if (this.state.callId && event.reason !== "replaced") {
            void this.transport
              .endCall(this.state.callId, "media_failed")
              .catch(() => undefined);
          }
          this.fail({
            kind: "connection_failed",
            message:
              "Gemini audio couldn't connect. A firewall or VPN may be blocking calls.",
          });
          return;
        }
        if (event.reason === "replaced") {
          // Another device took the call: leave it running there.
          void this.finish("remote", { hangUp: false });
          return;
        }
        void this.finish(
          event.reason === "closed" ? "remote" : "connection_lost",
        );
        return;
    }
  }

  /**
   * Refuses the call while a huddle owns the mic, and fails closed when the
   * huddle state can't be read. Also true when the attempt was superseded
   * meanwhile, so the caller stops either way.
   */
  private async abandonForHuddle(attempt: number): Promise<boolean> {
    let active: boolean | null;
    try {
      active = await this.transport.isHuddleActive();
    } catch {
      active = null;
    }
    if (attempt !== this.attempt) {
      return true;
    }
    if (active === null) {
      this.fail({ kind: "huddle_active", message: HUDDLE_UNKNOWN_MESSAGE });
      return true;
    }
    if (active) {
      this.fail({ kind: "huddle_active", message: HUDDLE_ACTIVE_MESSAGE });
    }
    return active;
  }

  /** Still connecting after the timeout: end as `media_failed`, close the mic. */
  private onConnectTimeout(attempt: number) {
    if (attempt !== this.attempt || this.state.phase !== "connecting") {
      return;
    }
    const callId = this.state.callId;
    if (callId) {
      void this.transport
        .endCall(callId, "media_failed")
        .catch(() => undefined);
    } else {
      this.timedOutAttempt = attempt;
    }
    this.fail({
      kind: "connection_failed",
      message:
        "The call couldn't connect. Check your connection and try again.",
    });
  }

  private scheduleLimit(attempt: number, executeUntil: string | null) {
    const until = executeUntil ? Date.parse(executeUntil) : Number.NaN;
    if (!Number.isFinite(until)) {
      return;
    }
    this.later(
      () => {
        if (attempt === this.attempt && this.isBusy) {
          void this.finish("time_limit");
        }
      },
      Math.max(0, until - this.transport.now()),
    );
  }

  private onPeerState(attempt: number) {
    const peer = this.peer;
    if (!peer || attempt !== this.attempt) {
      return;
    }
    const state = peer.connectionState;
    if (state === "connected") {
      if (this.disconnectTimer) {
        clearTimeout(this.disconnectTimer);
        this.disconnectTimer = null;
      }
      if (this.state.phase === "connecting") {
        if (this.connectTimer) {
          clearTimeout(this.connectTimer);
          this.timers.delete(this.connectTimer);
          this.connectTimer = null;
        }
        this.set({ phase: "live", connectedAt: this.transport.now() });
      }
      return;
    }
    if (state === "failed") {
      if (this.state.phase === "connecting") {
        if (this.state.callId) {
          void this.transport
            .endCall(this.state.callId, "media_failed")
            .catch(() => undefined);
        }
        this.fail({
          kind: "connection_failed",
          message:
            "Audio couldn't connect. A firewall or VPN may be blocking calls.",
        });
        return;
      }
      void this.finish("connection_lost");
      return;
    }
    if (state === "disconnected" && !this.disconnectTimer) {
      this.disconnectTimer = setTimeout(() => {
        this.disconnectTimer = null;
        if (
          attempt === this.attempt &&
          this.peer?.connectionState !== "connected" &&
          this.isBusy
        ) {
          void this.finish("connection_lost");
        }
      }, DISCONNECT_GRACE_MS);
    }
  }

  private onChannelMessage(data: unknown) {
    if (typeof data !== "string") {
      return;
    }
    let type: unknown;
    try {
      type = (JSON.parse(data) as { type?: unknown }).type;
    } catch {
      return;
    }
    if (type === "session.closed" && this.isBusy) {
      void this.finish("remote");
    }
  }

  /**
   * One long-poll loop per call: `wait=20`, again at once after each answer,
   * backing off 1 s → 15 s on errors. It stops on a dismiss or a new call,
   * on `404` (not this caller's call), and after hang-up once the recap is
   * written or 90 s have passed.
   */
  private followFeed(callId: string) {
    const token = ++this.feedToken;
    this.feedUntil = null;
    void this.runFeed(token, callId);
  }

  private async runFeed(token: number, callId: string) {
    let rev: string | null = null;
    let failures = 0;
    while (token === this.feedToken) {
      const ended = !this.isBusy;
      if (ended) {
        if (!feedWantsMore(this.state.feed)) return;
        if (this.feedUntil === null) {
          this.feedUntil = this.transport.now() + FEED_AFTER_END_MS;
        }
        if (this.transport.now() > this.feedUntil) return;
      }
      try {
        const answer = await this.transport.getFeed(
          callId,
          rev,
          ended ? 5 : FEED_WAIT_S,
        );
        failures = 0;
        if (token !== this.feedToken) return;
        if (isFeedSnapshot(answer)) {
          rev = answer.rev;
          if (answer.callId === callId) this.set({ feed: answer });
        } else if (answer && typeof answer.rev === "string") {
          rev = answer.rev;
        }
      } catch (error) {
        if (token !== this.feedToken) return;
        const status = (error as { status?: unknown }).status;
        if (status === 404 || status === 403 || status === 401) return;
        failures++;
        await new Promise((resolve) =>
          setTimeout(resolve, feedRetryDelay(failures)),
        );
      }
    }
  }

  toggleMute = () => {
    const tracks = this.stream?.getAudioTracks() ?? [];
    const muted = !this.state.muted;
    for (const track of tracks) {
      track.enabled = !muted;
    }
    // Gemini: `audio_stream_end`, then no audio until unmuted.
    this.streamSession?.setMuted(muted);
    this.set({ muted });
  };

  /** Stops the agent's current work (host stop control); the call goes on. */
  stopAgentWork = async () => {
    const callId = this.state.callId;
    if (!callId || this.state.stop.status === "stopping") {
      return;
    }
    const attempt = this.attempt;
    this.set({ stop: { status: "stopping" } });
    let next: AgentCallStopState;
    try {
      next = { status: await this.transport.stopWork(callId) };
    } catch {
      next = {
        status: "failed",
        message: "Couldn't stop the agent. Try again, or say “stop”.",
      };
    }
    if (attempt !== this.attempt) {
      return;
    }
    this.set({ stop: next });
    this.later(() => {
      if (attempt === this.attempt && this.state.stop === next) {
        this.set({ stop: { status: "idle" } });
      }
    }, STOP_STATUS_RESET_MS);
  };

  /** Hangs up. The agent keeps working; its answers land in the DM. */
  hangUp = () => this.finish("hangup");

  /** Hangs up when the window closes: best effort, nothing waits on it. */
  hangUpOnUnload = () => {
    if (!this.isBusy) {
      return;
    }
    const callId = this.state.callId;
    this.attempt++;
    this.feedToken++;
    this.releaseMedia();
    if (callId) {
      void this.transport.endCall(callId, "page_closed").catch(() => undefined);
    }
  };

  /** A community or identity switch: hang up and clear the screen. */
  reset = () => {
    if (this.isBusy) {
      const callId = this.state.callId;
      if (callId) {
        void this.transport
          .endCall(callId, "community_changed")
          .catch(() => undefined);
      }
    }
    this.attempt++;
    this.feedToken++;
    this.clearTimers();
    this.releaseMedia();
    this.set(IDLE);
  };

  private async finish(
    reason: AgentCallEndReason,
    options?: { hangUp?: boolean },
  ) {
    if (!this.isBusy) {
      return;
    }
    const callId = this.state.callId;
    this.attempt++;
    const attempt = this.attempt;
    this.clearTimers();
    this.releaseMedia();
    this.set({
      phase: "ending",
      reconnecting: false,
      endReason: reason,
      endedAt: this.transport.now(),
    });
    if (callId && options?.hangUp !== false) {
      await this.transport.endCall(callId, reason).catch(() => undefined);
    }
    if (attempt !== this.attempt) {
      return;
    }
    this.set({ phase: "ended" });
    // A call with something on its screen keeps it (the recap) until
    // closed; an empty one goes away (after one more feed answer).
    this.later(() => {
      if (
        attempt === this.attempt &&
        this.state.phase === "ended" &&
        (this.state.feed?.asks.length ?? 0) === 0
      ) {
        this.dismiss();
      }
    }, ENDED_DISMISS_MS);
  }

  private fail(
    error: { kind: AgentCallClientErrorKind; message: string },
    retryWith: VoiceProviderId | null = null,
  ) {
    this.attempt++;
    this.feedToken++;
    this.clearTimers();
    this.releaseMedia();
    this.set({
      phase: "error",
      error,
      retryWith,
      reconnecting: false,
      endedAt: this.transport.now(),
    });
  }

  /** Closes the error or "Call ended" screen. */
  dismiss = () => {
    if (this.isBusy) {
      return;
    }
    this.attempt++;
    this.feedToken++;
    this.clearTimers();
    this.set(IDLE);
  };

  private clearTimers() {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
  }

  private closeAudioContext() {
    const context = this.audioContext;
    this.audioContext = null;
    if (context && context.state !== "closed") {
      void context.close().catch(() => undefined);
    }
  }

  private releaseMedia() {
    this.streamSession?.close();
    this.streamSession = null;
    this.capture?.stop();
    this.capture = null;
    this.playback?.close();
    this.playback = null;
    this.closeAudioContext();
    if (this.stream) {
      stopTracks(this.stream);
    }
    this.stream = null;
    this.releasePeer();
    if (this.audio) {
      this.audio.pause();
      this.audio.srcObject = null;
      this.audio.remove();
      this.audio = null;
    }
  }

  /** The WebRTC side only (a Gemini call keeps the mic and audio element). */
  private releasePeer() {
    if (this.channel) {
      this.channel.onmessage = null;
      this.channel.onclose = null;
      try {
        this.channel.close();
      } catch {
        // Already closed.
      }
      this.channel = null;
    }
    if (this.peer) {
      this.peer.ontrack = null;
      this.peer.onconnectionstatechange = null;
      try {
        this.peer.close();
      } catch {
        // Already closed.
      }
      this.peer = null;
    }
  }
}

export const agentCallController = new AgentCallController();

/**
 * Huddle start/join guard: a huddle never starts beside a busy agent call
 * (the huddle is refused; the call is never ended for it).
 */
export function assertNoAgentCallForHuddle(
  action: "start" | "join",
  controller: AgentCallController = agentCallController,
) {
  if (!controller.isBusy) {
    return;
  }
  const name = controller.getState().agentName;
  throw new Error(
    `End your call with ${name ?? "your agent"} before you ${action} a huddle.`,
  );
}

/** Community switch seam (`resetCommunityState`). */
export function resetAgentCall() {
  agentCallController.reset();
}
