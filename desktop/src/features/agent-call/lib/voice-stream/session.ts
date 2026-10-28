/**
 * One Gemini call's stream socket (voice-provider-neutral §8, §9.4, §10):
 *
 * - opens with the `kiingo-voice-v1` and `kiingo-cap.<capability>`
 *   subprotocols, and sends audio only after `session.started`;
 * - a close without `session.closed` (4001, 4008, 4013, 1011, a dropped
 *   network, a stale socket) gets a fresh offer from stream-token and a new
 *   socket within 20 s, at most 5 times per call; the call view saying
 *   `ended` stops it;
 * - `session.reconnect` (a planned handover) opens the new socket beside the
 *   old one, which keeps playing until the new one's `session.started` (make
 *   before break). The capability inside it is never used: stream-token is
 *   asked for a fresh one;
 * - `4009` with no handover of ours means another stream took the call: it
 *   ends here without hanging up;
 * - mute sends `audio_stream_end` and no audio until unmuted.
 *
 * Captions arrive with the same event names as GPT-Live's data channel, so
 * everything above the transport (feed, working state, HumanAsk, stop and
 * end routes) is unchanged.
 */

import {
  VOICE_STREAM_CLOSE,
  VOICE_STREAM_PROTOCOL,
  VoiceStreamOfferError,
  base64ToPcm16,
  decodeVoiceStreamMessage,
  encodeAudioMessage,
  voiceStreamProtocols,
  type VoiceStreamOffer,
} from "./wire";

export type VoiceStreamEndReason =
  /** The server ended the call (`session.closed`). */
  | "closed"
  /** Another stream of this call replaced this one (`4009`). */
  | "replaced"
  /** Reconnects ran out (20 s or 5 tries). */
  | "lost"
  /** An offer failed its checks, or stream-token refused for good. */
  | "refused";

export type VoiceStreamSessionEvent =
  | { type: "started" }
  | { type: "first_audio" }
  | { type: "reconnecting"; cause: string }
  | { type: "resumed" }
  | { type: "input_transcript"; delta: string }
  | { type: "output_transcript"; delta: string }
  | { type: "ended"; reason: VoiceStreamEndReason; detail: string | null };

/** Thrown by `refreshOffer` when the call can't take a stream any more. */
export class VoiceStreamFatalError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "VoiceStreamFatalError";
  }
}

type SocketLike = Pick<
  WebSocket,
  "readyState" | "protocol" | "bufferedAmount" | "send" | "close"
> & {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
};

export type VoiceStreamSessionOptions = {
  /** The start response's offer, already checked (`parseVoiceStreamOffer`). */
  offer: VoiceStreamOffer;
  /** `POST …/calls/:id/stream-token`, checked. Throw VoiceStreamFatalError to stop. */
  refreshOffer: () => Promise<VoiceStreamOffer>;
  /** The call view says `ended`. Errors count as "not ended". */
  isCallEnded?: () => Promise<boolean>;
  /** Plays one 24 kHz delta. */
  onAudio: (pcm: Int16Array) => void;
  /** Barge-in: flush playback. */
  onInterrupted: () => void;
  onEvent: (event: VoiceStreamSessionEvent) => void;
  createSocket?: (url: string, protocols: string[]) => SocketLike;
  now?: () => number;
  reconnectWindowMs?: number;
  maxReconnects?: number;
  maxTokenReads?: number;
  maxHandovers?: number;
  /** A socket that says nothing for this long is closed and replaced. */
  staleMs?: number;
  pingMs?: number;
  connectTimeoutMs?: number;
};

type Stream = {
  socket: SocketLike;
  started: boolean;
  lastSeq: number;
  lastHeardAt: number;
  settle: ((started: boolean) => void) | null;
};

const OPEN = 1;
/** Above this, mic frames are dropped instead of queued behind a slow socket. */
const MAX_BUFFERED_BYTES = 256 * 1024;
const BACKOFF_MS = [0, 500, 1_000, 2_000, 4_000];

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export class VoiceStreamSession {
  private readonly options: Required<
    Omit<VoiceStreamSessionOptions, "isCallEnded">
  > &
    Pick<VoiceStreamSessionOptions, "isCallEnded">;
  private current: Stream | null = null;
  private pending: Stream | null = null;
  private ended = false;
  private muted = false;
  private everStarted = false;
  private heardAudio = false;
  private reconnecting = false;
  private reconnects = 0;
  private tokenReads = 0;
  private handovers = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: VoiceStreamSessionOptions) {
    this.options = {
      createSocket: (url, protocols) =>
        new WebSocket(url, protocols) as unknown as SocketLike,
      now: () => Date.now(),
      reconnectWindowMs: 20_000,
      maxReconnects: 5,
      maxTokenReads: 16,
      maxHandovers: 8,
      staleMs: 45_000,
      pingMs: 15_000,
      connectTimeoutMs: 10_000,
      ...options,
    };
  }

  get isEnded(): boolean {
    return this.ended;
  }

  /** Opens the first socket. Resolves when it is started or reconnecting. */
  async start(): Promise<void> {
    this.pingTimer = setInterval(() => this.keepAlive(), this.options.pingMs);
    const started = await this.connect(this.options.offer, "current");
    if (!started && !this.ended) {
      void this.reconnect("connect_failed");
    }
  }

  /** One 16 kHz frame from the mic. Dropped unless live and unmuted. */
  sendAudio(pcm: Int16Array): void {
    const stream = this.current;
    if (
      this.ended ||
      this.muted ||
      !stream?.started ||
      stream.socket.readyState !== OPEN ||
      stream.socket.bufferedAmount > MAX_BUFFERED_BYTES
    ) {
      return;
    }
    stream.socket.send(encodeAudioMessage(pcm));
  }

  setMuted(muted: boolean): void {
    if (this.muted === muted) {
      return;
    }
    this.muted = muted;
    if (muted) {
      this.sendJson(this.current, { type: "audio_stream_end" });
    }
  }

  /** Closes every socket here; the call itself ends through the end route. */
  close(): void {
    this.finish(null);
  }

  private finish(
    end: { reason: VoiceStreamEndReason; detail: string | null } | null,
  ) {
    if (this.ended) {
      return;
    }
    this.ended = true;
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    for (const stream of [this.current, this.pending]) {
      if (stream) {
        this.drop(stream, VOICE_STREAM_CLOSE.normal, "client_closed");
      }
    }
    this.current = null;
    this.pending = null;
    if (end) {
      this.options.onEvent({ type: "ended", ...end });
    }
  }

  private sendJson(stream: Stream | null, message: Record<string, unknown>) {
    if (stream?.started && stream.socket.readyState === OPEN) {
      stream.socket.send(JSON.stringify(message));
    }
  }

  private drop(stream: Stream, code: number, reason: string) {
    stream.settle?.(false);
    stream.settle = null;
    const { socket } = stream;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  private keepAlive() {
    const stream = this.current;
    if (this.ended || !stream || stream.socket.readyState !== OPEN) {
      return;
    }
    if (this.options.now() - stream.lastHeardAt > this.options.staleMs) {
      // A silent socket: replace it as if it dropped.
      this.drop(stream, 4000, "stale");
      this.onStreamClosed(stream, 4000);
      return;
    }
    this.sendJson(stream, { type: "ping", t: this.options.now() });
  }

  /** Opens one socket; resolves true on its `session.started`. */
  private connect(
    offer: VoiceStreamOffer,
    role: "current" | "pending",
  ): Promise<boolean> {
    if (this.ended) {
      return Promise.resolve(false);
    }
    let socket: SocketLike;
    try {
      socket = this.options.createSocket(
        offer.url,
        voiceStreamProtocols(offer),
      );
    } catch {
      return Promise.resolve(false);
    }
    const stream: Stream = {
      socket,
      started: false,
      lastSeq: -Infinity,
      lastHeardAt: this.options.now(),
      settle: null,
    };
    if (role === "current") {
      this.current = stream;
    } else {
      this.pending = stream;
    }
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (!stream.started && !this.ended) {
          this.drop(stream, 4000, "connect_timeout");
          this.onStreamClosed(stream, 4000);
        }
      }, this.options.connectTimeoutMs);
      stream.settle = (started) => {
        clearTimeout(timer);
        resolve(started);
      };
      socket.onopen = () => {
        // The server selects only kiingo-voice-v1.
        if (socket.protocol && socket.protocol !== VOICE_STREAM_PROTOCOL) {
          this.drop(stream, VOICE_STREAM_CLOSE.normal, "protocol");
          this.onStreamClosed(stream, VOICE_STREAM_CLOSE.capability);
        }
      };
      socket.onmessage = (event) => this.onMessage(stream, event.data);
      socket.onclose = (event) => {
        socket.onclose = null;
        this.onStreamClosed(stream, event.code);
      };
      socket.onerror = () => undefined;
    });
  }

  private onMessage(stream: Stream, data: unknown) {
    if (this.ended) {
      return;
    }
    stream.lastHeardAt = this.options.now();
    const message = decodeVoiceStreamMessage(data);
    if (!message) {
      return;
    }
    const isCurrent = stream === this.current;
    switch (message.type) {
      case "session.started": {
        if (stream.started) {
          return;
        }
        stream.started = true;
        if (stream === this.pending) {
          // Make before break: the new socket takes over now.
          const old = this.current;
          this.current = stream;
          this.pending = null;
          if (old) {
            this.drop(old, VOICE_STREAM_CLOSE.normal, "handover");
          }
        }
        stream.settle?.(true);
        stream.settle = null;
        if (this.muted) {
          this.sendJson(stream, { type: "audio_stream_end" });
        }
        if (!this.everStarted) {
          this.everStarted = true;
          this.options.onEvent({ type: "started" });
        }
        return;
      }
      case "audio.delta": {
        if (!isCurrent || !stream.started) {
          return;
        }
        if (message.seq !== null) {
          if (message.seq <= stream.lastSeq) {
            return;
          }
          stream.lastSeq = message.seq;
        }
        let pcm: Int16Array;
        try {
          pcm = base64ToPcm16(message.data);
        } catch {
          return;
        }
        if (!this.heardAudio) {
          this.heardAudio = true;
          this.options.onEvent({ type: "first_audio" });
        }
        this.options.onAudio(pcm);
        return;
      }
      case "audio.interrupted":
        if (isCurrent) {
          this.options.onInterrupted();
        }
        return;
      case "session.input_transcript.delta":
        if (isCurrent) {
          this.options.onEvent({
            type: "input_transcript",
            delta: message.delta,
          });
        }
        return;
      case "session.output_transcript.delta":
        if (isCurrent) {
          this.options.onEvent({
            type: "output_transcript",
            delta: message.delta,
          });
        }
        return;
      case "session.reconnect":
        if (isCurrent) {
          void this.handover();
        }
        return;
      case "session.closed":
        this.finish({ reason: "closed", detail: message.reason });
        return;
      case "pong":
        return;
    }
  }

  private onStreamClosed(stream: Stream, code: number) {
    stream.settle?.(false);
    stream.settle = null;
    if (this.ended) {
      return;
    }
    if (stream === this.pending) {
      this.pending = null;
      // A failed handover: the old socket goes on if it still can.
      if (!this.current) {
        void this.reconnect(`handover_${code}`);
      }
      return;
    }
    if (stream !== this.current) {
      return;
    }
    this.current = null;
    if (this.pending) {
      // The server closes the old socket (4009) once the new one connects.
      return;
    }
    if (code === VOICE_STREAM_CLOSE.replaced && this.everStarted) {
      this.finish({ reason: "replaced", detail: null });
      return;
    }
    void this.reconnect(`close_${code}`);
  }

  private async readOffer(): Promise<VoiceStreamOffer> {
    if (this.tokenReads >= this.options.maxTokenReads) {
      throw new VoiceStreamFatalError("stream_token_limit");
    }
    this.tokenReads++;
    return this.options.refreshOffer();
  }

  private async handover() {
    if (
      this.pending ||
      this.reconnecting ||
      this.handovers >= this.options.maxHandovers
    ) {
      return;
    }
    this.handovers++;
    let offer: VoiceStreamOffer;
    try {
      offer = await this.readOffer();
    } catch (error) {
      if (error instanceof VoiceStreamOfferError) {
        this.finish({ reason: "refused", detail: error.code });
      }
      // Otherwise stay on the old socket; its close reconnects.
      return;
    }
    if (this.ended || this.pending || !this.current) {
      return;
    }
    await this.connect(offer, "pending");
  }

  private async reconnect(cause: string) {
    if (this.reconnecting || this.ended) {
      return;
    }
    this.reconnecting = true;
    this.options.onEvent({ type: "reconnecting", cause });
    const deadline = this.options.now() + this.options.reconnectWindowMs;
    let attempt = 0;
    try {
      while (!this.ended) {
        if (
          this.reconnects >= this.options.maxReconnects ||
          this.options.now() >= deadline
        ) {
          this.finish({ reason: "lost", detail: cause });
          return;
        }
        this.reconnects++;
        const wait = Math.min(
          BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)],
          Math.max(0, deadline - this.options.now()),
        );
        attempt++;
        if (wait > 0) {
          await sleep(wait);
        }
        if (this.ended) {
          return;
        }
        if (this.options.isCallEnded) {
          const over = await this.options.isCallEnded().catch(() => false);
          if (over) {
            this.finish({ reason: "closed", detail: "ended" });
            return;
          }
        }
        let offer: VoiceStreamOffer;
        try {
          offer = await this.readOffer();
        } catch (error) {
          if (error instanceof VoiceStreamOfferError) {
            this.finish({ reason: "refused", detail: error.code });
            return;
          }
          if (error instanceof VoiceStreamFatalError) {
            this.finish({
              reason:
                error.code === "voice_call_not_live" ? "closed" : "refused",
              detail: error.code,
            });
            return;
          }
          continue;
        }
        if (this.ended) {
          return;
        }
        if (await this.connect(offer, "current")) {
          this.options.onEvent({ type: "resumed" });
          return;
        }
      }
    } finally {
      this.reconnecting = false;
    }
  }
}
