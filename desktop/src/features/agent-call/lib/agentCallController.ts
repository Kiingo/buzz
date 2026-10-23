import {
  type StartAgentCallResponse,
  describeAgentCallError,
  endAgentCall,
  getAgentCallFeed,
  startAgentCall,
  stopAgentCallWork,
} from "./agentCallApi";
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
 * Hang-up ends the call only. It never cancels the agent's work; its answers
 * land in the DM. Stop does that, through the host's stop control.
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
  | "connection_failed";

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
  now: () => number;
};

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
  now: () => Date.now(),
});

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
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(transport?: Partial<Transport>) {
    this.transport = {
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
  }) => {
    if (this.isBusy) {
      return;
    }
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
    });
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

    try {
      this.stream = await this.transport.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
    } catch (error) {
      if (attempt === this.attempt) {
        this.fail(describeMicError(error));
      }
      return;
    }
    if (attempt !== this.attempt) {
      this.releaseMedia();
      return;
    }
    this.set({ phase: "connecting" });

    let offerSdp: string;
    try {
      const peer = this.transport.createPeerConnection();
      this.peer = peer;
      for (const track of this.stream.getAudioTracks()) {
        peer.addTrack(track, this.stream);
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

    let response: StartAgentCallResponse;
    try {
      response = await this.transport.startCall({
        agentPubkey: input.agentPubkey,
        channelId: input.channelId,
        sdpOffer: offerSdp,
        clientTapAt: tapAt,
      });
    } catch (error) {
      if (attempt === this.attempt) {
        this.fail({
          kind: "request_failed",
          message: describeAgentCallError(error),
        });
      }
      return;
    }
    if (attempt !== this.attempt) {
      // Hung up while the host was answering: end the call it opened.
      void this.transport
        .endCall(response.callId, "hangup")
        .catch(() => undefined);
      return;
    }
    this.set({ callId: response.callId, executeUntil: response.executeUntil });
    this.followFeed(response.callId);

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

  private async finish(reason: AgentCallEndReason) {
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
      endReason: reason,
      endedAt: this.transport.now(),
    });
    if (callId) {
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

  private fail(error: { kind: AgentCallClientErrorKind; message: string }) {
    this.attempt++;
    this.feedToken++;
    this.clearTimers();
    this.releaseMedia();
    this.set({
      phase: "error",
      error,
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

  private releaseMedia() {
    for (const track of this.stream?.getTracks() ?? []) {
      track.stop();
    }
    this.stream = null;
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
    if (this.audio) {
      this.audio.pause();
      this.audio.srcObject = null;
      this.audio.remove();
      this.audio = null;
    }
  }
}

export const agentCallController = new AgentCallController();

/** Community switch seam (`resetCommunityState`). */
export function resetAgentCall() {
  agentCallController.reset();
}
