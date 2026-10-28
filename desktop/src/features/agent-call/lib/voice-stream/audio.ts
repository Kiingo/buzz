/**
 * Client audio duties for the stream (voice-provider-neutral §10.4): echo
 * cancelled capture at 16 kHz s16le in 40 ms frames, and 24 kHz playback
 * behind a small jitter buffer, routed through a MediaStream so the
 * browser's echo canceller can reference what the voice says.
 */

import {
  VOICE_STREAM_FRAME_MS,
  VOICE_STREAM_INPUT_RATE_HZ,
  VOICE_STREAM_OUTPUT_RATE_HZ,
} from "./wire";

/** getUserMedia constraints: echo cancellation is required (the server VAD must not hear the voice). */
export const VOICE_STREAM_MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  },
  video: false,
};

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

const audioContextCtor = (): AudioContextCtor | null => {
  if (typeof window === "undefined") {
    return null;
  }
  const scope = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
};

/** Whether this browser can run the stream's audio (Web Audio + AudioWorklet + WebSocket). */
export const canRunVoiceStream = (): boolean => {
  const Ctor = audioContextCtor();
  return (
    Ctor !== null &&
    typeof WebSocket !== "undefined" &&
    typeof AudioWorkletNode !== "undefined" &&
    "audioWorklet" in Ctor.prototype &&
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  );
};

/**
 * The call's AudioContext. Create it inside the tap's handler: Safari only
 * lets a context run (and audio play) from a user gesture.
 */
export const createVoiceStreamAudioContext = (): AudioContext | null => {
  const Ctor = audioContextCtor();
  if (!Ctor) {
    return null;
  }
  const context = new Ctor({ latencyHint: "interactive" });
  void context.resume().catch(() => undefined);
  return context;
};

/** The worklet module's URL: served from the app's origin by the bundler. */
export const defaultCaptureWorkletUrl = (): URL =>
  new URL("./capture-worklet.js", import.meta.url);

export type VoiceStreamCapture = { stop(): void };

/**
 * Starts capture from `stream` (already echo cancelled) into `onFrame`:
 * each call gets one frame of 16 kHz mono s16 samples.
 */
export const startVoiceStreamCapture = async (params: {
  context: AudioContext;
  stream: MediaStream;
  onFrame: (pcm: Int16Array) => void;
  workletUrl?: string | URL;
  frameMs?: number;
}): Promise<VoiceStreamCapture> => {
  const { context } = params;
  await context.audioWorklet.addModule(
    String(params.workletUrl ?? defaultCaptureWorkletUrl()),
  );
  const source = context.createMediaStreamSource(params.stream);
  // Anti-alias before the worklet's interpolating resampler.
  const filters: BiquadFilterNode[] = [];
  if (context.sampleRate > VOICE_STREAM_INPUT_RATE_HZ * 1.1) {
    for (let i = 0; i < 2; i++) {
      const filter = context.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = VOICE_STREAM_INPUT_RATE_HZ * 0.45;
      filter.Q.value = Math.SQRT1_2;
      filters.push(filter);
    }
  }
  const frameMs = params.frameMs ?? VOICE_STREAM_FRAME_MS;
  const node = new AudioWorkletNode(context, "kiingo-pcm16-capture", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: "explicit",
    channelInterpretation: "speakers",
    processorOptions: {
      targetRate: VOICE_STREAM_INPUT_RATE_HZ,
      frameSamples: Math.round((VOICE_STREAM_INPUT_RATE_HZ * frameMs) / 1000),
    },
  });
  let stopped = false;
  node.port.onmessage = (event: MessageEvent) => {
    if (!stopped && event.data instanceof Int16Array) {
      params.onFrame(event.data);
    }
  };
  // A worklet is only pulled when it reaches the destination: through silence.
  const sink = context.createGain();
  sink.gain.value = 0;
  let previous: AudioNode = source;
  for (const filter of filters) {
    previous.connect(filter);
    previous = filter;
  }
  previous.connect(node);
  node.connect(sink);
  sink.connect(context.destination);
  return {
    stop: () => {
      if (stopped) {
        return;
      }
      stopped = true;
      node.port.onmessage = null;
      try {
        node.port.postMessage("stop");
      } catch {
        // Closed.
      }
      for (const audioNode of [source, ...filters, node, sink]) {
        try {
          audioNode.disconnect();
        } catch {
          // Already disconnected.
        }
      }
    },
  };
};

export type VoiceStreamPlaybackOptions = {
  context: AudioContext;
  /**
   * Plays the voice. With it, playback goes through a MediaStream (and, where
   * WebRTC exists, a local loopback peer) so the echo canceller references
   * it; without it, straight to the context's destination.
   */
  audioElement?: HTMLAudioElement | null;
  /** Prebuffer when playback starts or after an underrun. Default 80 ms (60–120). */
  jitterMs?: number;
  /** Newer audio past this much queued is dropped. Default 8 s. */
  maxAheadMs?: number;
  /** Route through a loopback RTCPeerConnection (Chrome's AEC references only WebRTC audio). Default true. */
  aecLoopback?: boolean;
};

/** 24 kHz s16 playback with a jitter buffer; `flush()` on barge-in. */
export class VoiceStreamPlayback {
  private readonly context: AudioContext;
  private readonly gain: GainNode;
  private readonly jitterS: number;
  private readonly maxAheadS: number;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private nextTime = 0;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private loopback: [RTCPeerConnection, RTCPeerConnection] | null = null;
  private closed = false;

  constructor(private readonly options: VoiceStreamPlaybackOptions) {
    this.context = options.context;
    this.gain = this.context.createGain();
    this.jitterS = Math.min(Math.max(options.jitterMs ?? 80, 40), 200) / 1000;
    this.maxAheadS = (options.maxAheadMs ?? 8_000) / 1000;
  }

  /** Wires the output. Resolves once audio has somewhere to go. */
  async attach(): Promise<void> {
    const element = this.options.audioElement;
    if (
      !element ||
      typeof this.context.createMediaStreamDestination !== "function"
    ) {
      this.gain.connect(this.context.destination);
      return;
    }
    const destination = this.context.createMediaStreamDestination();
    this.destination = destination;
    this.gain.connect(destination);
    if (
      this.options.aecLoopback !== false &&
      typeof RTCPeerConnection !== "undefined"
    ) {
      try {
        const remote = await this.openLoopback(destination.stream);
        if (!this.closed) {
          element.srcObject = remote;
          void element.play().catch(() => undefined);
          return;
        }
      } catch {
        this.closeLoopback();
      }
    }
    if (!this.closed) {
      element.srcObject = destination.stream;
      void element.play().catch(() => undefined);
    }
  }

  private async openLoopback(stream: MediaStream): Promise<MediaStream> {
    const sender = new RTCPeerConnection();
    const receiver = new RTCPeerConnection();
    this.loopback = [sender, receiver];
    sender.onicecandidate = (event) => {
      if (event.candidate) {
        void receiver.addIceCandidate(event.candidate).catch(() => undefined);
      }
    };
    receiver.onicecandidate = (event) => {
      if (event.candidate) {
        void sender.addIceCandidate(event.candidate).catch(() => undefined);
      }
    };
    const remote = new Promise<MediaStream>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("loopback_timeout")),
        3_000,
      );
      receiver.ontrack = (event) => {
        clearTimeout(timer);
        resolve(event.streams[0] ?? new MediaStream([event.track]));
      };
    });
    for (const track of stream.getAudioTracks()) {
      sender.addTrack(track, stream);
    }
    const offer = await sender.createOffer();
    await sender.setLocalDescription(offer);
    await receiver.setRemoteDescription(offer);
    const answer = await receiver.createAnswer();
    await receiver.setLocalDescription(answer);
    await sender.setRemoteDescription(answer);
    return remote;
  }

  private closeLoopback() {
    for (const peer of this.loopback ?? []) {
      peer.onicecandidate = null;
      peer.ontrack = null;
      try {
        peer.close();
      } catch {
        // Closed.
      }
    }
    this.loopback = null;
  }

  /** Seconds of voice still queued. */
  get queuedSeconds(): number {
    return Math.max(0, this.nextTime - this.context.currentTime);
  }

  /** Queues one delta; false when dropped (closed, empty or too far ahead). */
  enqueue(pcm: Int16Array): boolean {
    if (this.closed || pcm.length === 0) {
      return false;
    }
    const now = this.context.currentTime;
    if (this.nextTime < now + 0.005) {
      this.nextTime = now + this.jitterS;
    }
    if (this.nextTime - now > this.maxAheadS) {
      return false;
    }
    const buffer = this.context.createBuffer(
      1,
      pcm.length,
      VOICE_STREAM_OUTPUT_RATE_HZ,
    );
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) {
      channel[i] = pcm[i] / 0x8000;
    }
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    source.onended = () => {
      this.sources.delete(source);
      try {
        source.disconnect();
      } catch {
        // Already disconnected.
      }
    };
    this.sources.add(source);
    source.start(this.nextTime);
    this.nextTime += buffer.duration;
    return true;
  }

  /** Barge-in: drops everything queued, now. */
  flush(): void {
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Not started or already stopped.
      }
      try {
        source.disconnect();
      } catch {
        // Already disconnected.
      }
    }
    this.sources.clear();
    this.nextTime = 0;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.flush();
    this.closed = true;
    this.closeLoopback();
    try {
      this.gain.disconnect();
    } catch {
      // Already disconnected.
    }
    for (const track of this.destination?.stream.getTracks() ?? []) {
      track.stop();
    }
    this.destination = null;
    const element = this.options.audioElement;
    if (element) {
      element.srcObject = null;
    }
  }
}
