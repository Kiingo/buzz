/**
 * The `kiingo-voice-v1` stream: the offer a client may connect with (§9.4)
 * and the JSON frames both ways (§10). Strict on what it accepts, because the
 * offer carries a one-use capability and the socket carries the caller's
 * voice.
 */

export const VOICE_STREAM_PROTOCOL = "kiingo-voice-v1";
export const VOICE_STREAM_CAPABILITY_PROTOCOL_PREFIX = "kiingo-cap.";
/** The `clientCapabilities` entry that says this client runs the stream. */
export const VOICE_STREAM_CLIENT_CAPABILITY = "gemini_ws";

export const VOICE_STREAM_CLOSE = {
  normal: 1000,
  serverError: 1011,
  capability: 4001,
  inputPolicy: 4008,
  replaced: 4009,
  draining: 4013,
} as const;

export const VOICE_STREAM_INPUT_RATE_HZ = 16_000;
export const VOICE_STREAM_OUTPUT_RATE_HZ = 24_000;
/** 40 ms of 16 kHz mono: 640 samples, 1,280 bytes. */
export const VOICE_STREAM_FRAME_MS = 40;
/** Inbound frames above this are dropped unread. */
export const VOICE_STREAM_MAX_INBOUND_CHARS = 256 * 1024;

export type VoiceStreamOffer = {
  url: string;
  protocol: typeof VOICE_STREAM_PROTOCOL;
  /** `vsc1.…`: one use, 30 s. Never logged, stored or shown. */
  capability: string;
  expiresAt: string | null;
  input: {
    encoding: "pcm_s16le";
    sampleRateHz: typeof VOICE_STREAM_INPUT_RATE_HZ;
    channels: 1;
    maxBytesPerMessage: number;
    recommendedFrameMs: number;
  };
  output: {
    encoding: "pcm_s16le";
    sampleRateHz: typeof VOICE_STREAM_OUTPUT_RATE_HZ;
    channels: 1;
  };
};

export type VoiceStreamRefusalCode =
  | "offer_malformed"
  | "offer_scheme"
  | "offer_host"
  | "offer_path"
  | "offer_protocol"
  | "offer_capability"
  | "offer_format";

/** A stream offer this client will not connect to. The message is the code. */
export class VoiceStreamOfferError extends Error {
  constructor(readonly code: VoiceStreamRefusalCode) {
    super(code);
    this.name = "VoiceStreamOfferError";
  }
}

export type VoiceStreamOfferExpectation = {
  callId: string;
  /**
   * The API hosts (`host[:port]`, lower case) the socket may go to: the
   * app's own API host, never one taken from the response.
   */
  apiHosts: readonly string[];
  /** Default `/api/voice/calls`. */
  pathPrefix?: string;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const CALL_ID = /^[A-Za-z0-9-]{1,64}$/u;
const CAPABILITY = /^vsc1\.[A-Za-z0-9_-]{20,128}$/u;

export const isLoopbackHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return (
    host === "localhost" ||
    host === "::1" ||
    /^127(?:\.\d{1,3}){3}$/u.test(host)
  );
};

/**
 * Checks an offer before anything opens (lane B's `VoiceStreamOffer.validate`):
 * `wss` (`ws` only to a loopback host), the host exactly one of the API's, no
 * userinfo, the path exactly `<prefix>/<this call>/stream`, no query or
 * fragment, protocol `kiingo-voice-v1`, a well-formed capability, and the
 * formats pcm_s16le 16 kHz in and 24 kHz out.
 */
export const parseVoiceStreamOffer = (
  value: unknown,
  expect: VoiceStreamOfferExpectation,
): VoiceStreamOffer => {
  const record = asRecord(value);
  if (!record || typeof record.url !== "string") {
    throw new VoiceStreamOfferError("offer_malformed");
  }
  let url: URL;
  try {
    url = new URL(record.url);
  } catch {
    throw new VoiceStreamOfferError("offer_malformed");
  }
  if (
    !(
      url.protocol === "wss:" ||
      (url.protocol === "ws:" && isLoopbackHost(url.hostname))
    )
  ) {
    throw new VoiceStreamOfferError("offer_scheme");
  }
  const hosts = expect.apiHosts.map((host) => host.toLowerCase());
  if (url.username || url.password || !hosts.includes(url.host.toLowerCase())) {
    throw new VoiceStreamOfferError("offer_host");
  }
  const prefix = (expect.pathPrefix ?? "/api/voice/calls").replace(/\/+$/u, "");
  if (
    !CALL_ID.test(expect.callId) ||
    url.pathname !== `${prefix}/${expect.callId}/stream` ||
    url.search ||
    url.hash ||
    record.url.includes("?") ||
    record.url.includes("#")
  ) {
    throw new VoiceStreamOfferError("offer_path");
  }
  if (record.protocol !== VOICE_STREAM_PROTOCOL) {
    throw new VoiceStreamOfferError("offer_protocol");
  }
  if (
    typeof record.capability !== "string" ||
    !CAPABILITY.test(record.capability)
  ) {
    throw new VoiceStreamOfferError("offer_capability");
  }
  const input = asRecord(record.input);
  const output = asRecord(record.output);
  if (
    input?.encoding !== "pcm_s16le" ||
    input.sampleRateHz !== VOICE_STREAM_INPUT_RATE_HZ ||
    (input.channels !== undefined && input.channels !== 1) ||
    output?.encoding !== "pcm_s16le" ||
    output.sampleRateHz !== VOICE_STREAM_OUTPUT_RATE_HZ ||
    (output.channels !== undefined && output.channels !== 1)
  ) {
    throw new VoiceStreamOfferError("offer_format");
  }
  const maxBytes =
    typeof input.maxBytesPerMessage === "number" &&
    Number.isInteger(input.maxBytesPerMessage) &&
    input.maxBytesPerMessage >= 1_280
      ? Math.min(input.maxBytesPerMessage, 32_000)
      : 32_000;
  const frameMs =
    typeof input.recommendedFrameMs === "number" &&
    input.recommendedFrameMs >= 10 &&
    input.recommendedFrameMs <= 100
      ? Math.round(input.recommendedFrameMs)
      : VOICE_STREAM_FRAME_MS;
  return {
    url: url.toString(),
    protocol: VOICE_STREAM_PROTOCOL,
    capability: record.capability,
    expiresAt: typeof record.expiresAt === "string" ? record.expiresAt : null,
    input: {
      encoding: "pcm_s16le",
      sampleRateHz: VOICE_STREAM_INPUT_RATE_HZ,
      channels: 1,
      maxBytesPerMessage: maxBytes,
      recommendedFrameMs: frameMs,
    },
    output: {
      encoding: "pcm_s16le",
      sampleRateHz: VOICE_STREAM_OUTPUT_RATE_HZ,
      channels: 1,
    },
  };
};

/** The subprotocols to open the socket with (the capability goes nowhere else). */
export const voiceStreamProtocols = (offer: VoiceStreamOffer): string[] => [
  VOICE_STREAM_PROTOCOL,
  `${VOICE_STREAM_CAPABILITY_PROTOCOL_PREFIX}${offer.capability}`,
];

export type VoiceStreamServerMessage =
  | { type: "session.started"; callId: string | null; model: string | null }
  | { type: "audio.delta"; seq: number | null; data: string }
  | { type: "audio.interrupted" }
  | { type: "session.input_transcript.delta"; delta: string }
  | { type: "session.output_transcript.delta"; delta: string }
  /** The embedded offer is never used: a handover asks stream-token. */
  | { type: "session.reconnect"; reason: string | null }
  | { type: "session.closed"; reason: string | null }
  | { type: "pong"; t: number | null };

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;

/** One inbound text frame, or null for anything this client ignores. */
export const decodeVoiceStreamMessage = (
  text: unknown,
): VoiceStreamServerMessage | null => {
  if (
    typeof text !== "string" ||
    text.length > VOICE_STREAM_MAX_INBOUND_CHARS
  ) {
    return null;
  }
  let record: Record<string, unknown> | null;
  try {
    record = asRecord(JSON.parse(text));
  } catch {
    return null;
  }
  if (!record) {
    return null;
  }
  const str = (value: unknown) => (typeof value === "string" ? value : null);
  switch (record.type) {
    case "session.started":
      return {
        type: "session.started",
        callId: str(record.callId),
        model: str(record.model),
      };
    case "audio.delta": {
      const data = str(record.data);
      if (!data || data.length % 4 !== 0 || !BASE64.test(data)) {
        return null;
      }
      return {
        type: "audio.delta",
        seq:
          typeof record.seq === "number" && Number.isFinite(record.seq)
            ? record.seq
            : null,
        data,
      };
    }
    case "audio.interrupted":
      return { type: "audio.interrupted" };
    case "session.input_transcript.delta":
    case "session.output_transcript.delta": {
      const delta = str(record.delta);
      return delta === null ? null : { type: record.type, delta };
    }
    case "session.reconnect":
      return { type: "session.reconnect", reason: str(record.reason) };
    case "session.closed":
      return { type: "session.closed", reason: str(record.reason) };
    case "pong":
      return {
        type: "pong",
        t: typeof record.t === "number" ? record.t : null,
      };
    default:
      return null;
  }
};

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** pcm_s16le bytes to base64. */
export const pcm16ToBase64 = (pcm: Int16Array): string => {
  let bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  if (!LITTLE_ENDIAN) {
    const swapped = new Uint8Array(bytes.length);
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      swapped[i] = bytes[i + 1];
      swapped[i + 1] = bytes[i];
    }
    bytes = swapped;
  }
  let binary = "";
  const chunk = 0x2000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
};

/** base64 pcm_s16le to samples (an odd trailing byte is dropped). */
export const base64ToPcm16 = (data: string): Int16Array => {
  const binary = atob(data);
  const count = binary.length >> 1;
  const out = new Int16Array(count);
  for (let i = 0; i < count; i++) {
    const lo = binary.charCodeAt(2 * i);
    const hi = binary.charCodeAt(2 * i + 1);
    const value = (hi << 8) | lo;
    out[i] = value >= 0x8000 ? value - 0x10000 : value;
  }
  return out;
};

export const encodeAudioMessage = (pcm: Int16Array): string =>
  JSON.stringify({ type: "audio", data: pcm16ToBase64(pcm) });
