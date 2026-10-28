/**
 * The caller's voice provider settings and the start response's provider
 * (docs/design/voice-provider-neutral.md §4, §9.1 and §9.3), read leniently.
 * The words match the iPhone and Mac apps (lane B, `VoiceProvider.swift`).
 */

export type VoiceProviderId = "gpt-live" | "gemini";

export const VOICE_PROVIDER_IDS: readonly VoiceProviderId[] = [
  "gpt-live",
  "gemini",
];

/** The system default until Ross says otherwise (§4.2). */
export const VOICE_SYSTEM_DEFAULT_PROVIDER: VoiceProviderId = "gpt-live";

/** Labels for when the settings read is not at hand. */
export const VOICE_PROVIDER_FALLBACK_LABELS: Readonly<
  Record<VoiceProviderId, string>
> = {
  "gpt-live": "GPT-Live",
  gemini: "Gemini",
};

export const readVoiceProviderId = (value: unknown): VoiceProviderId | null =>
  value === "gpt-live" || value === "gemini" ? value : null;

export type VoiceProviderUnavailableReason =
  | "no_credential"
  | "model_grant_missing"
  | "client_transport"
  | "provider_error"
  | (string & {});

/** One sentence for the person, never the code. */
export const voiceProviderUnavailableSentence = (
  reason: VoiceProviderUnavailableReason | null | undefined,
  label: string,
): string => {
  switch (reason) {
    case "no_credential":
      return `${label} needs a Google Cloud Gemini key for your organization.`;
    case "model_grant_missing":
      return `${label} isn’t enabled for your account yet.`;
    case "client_transport":
      return `This version of the app can’t run ${label} calls.`;
    case "provider_error":
      return `${label} is having trouble right now.`;
    default:
      return `${label} isn’t available right now.`;
  }
};

export type VoiceProviderOption = {
  id: VoiceProviderId;
  label: string;
  model: string | null;
  transport: "webrtc" | "gemini_ws" | null;
  available: boolean;
  unavailableReason: VoiceProviderUnavailableReason | null;
};

export type VoiceProviderSource = "call" | "agent" | "user" | "system";

export type VoiceEffectiveProvider = {
  agentId: string;
  provider: VoiceProviderId;
  source: VoiceProviderSource;
  available: boolean;
  fallbackFrom: VoiceProviderId | null;
  fallbackReason: VoiceProviderUnavailableReason | null;
  model: string | null;
  voice: string | null;
  thinkingLevel: string | null;
  /** The override's own revision (0 = none set), for the agent PUT. */
  revision: number;
};

export type VoiceSettings = {
  /** Only the providers this client knows, in the server's order. */
  providers: VoiceProviderOption[];
  systemDefault: VoiceProviderId;
  userDefault: VoiceProviderId | null;
  agentOverrides: { agentId: string; provider: VoiceProviderId }[];
  /** The default's revision, for the default PUT. */
  revision: number;
  effective: VoiceEffectiveProvider | null;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const str = (value: unknown): string | null =>
  typeof value === "string" && value ? value : null;

const revisionOf = (value: unknown): number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : 0;

const sourceOf = (value: unknown): VoiceProviderSource =>
  value === "call" || value === "agent" || value === "user" ? value : "system";

/** `GET /api/voice/settings` (the `{ data }` envelope or its body). */
export const parseVoiceSettings = (value: unknown): VoiceSettings | null => {
  const outer = asRecord(value);
  const record = asRecord(outer?.data) ?? outer;
  if (!record || !Array.isArray(record.providers)) {
    return null;
  }
  const providers: VoiceProviderOption[] = [];
  for (const entry of record.providers) {
    const row = asRecord(entry);
    const id = readVoiceProviderId(row?.id);
    if (!row || !id || providers.some((known) => known.id === id)) {
      continue;
    }
    providers.push({
      id,
      label: str(row.label) ?? VOICE_PROVIDER_FALLBACK_LABELS[id],
      model: str(row.model),
      transport:
        row.transport === "webrtc" || row.transport === "gemini_ws"
          ? row.transport
          : null,
      available: row.available !== false,
      unavailableReason:
        row.available === false ? str(row.unavailableReason) : null,
    });
  }
  const overrides: VoiceSettings["agentOverrides"] = [];
  if (Array.isArray(record.agentOverrides)) {
    for (const entry of record.agentOverrides) {
      const row = asRecord(entry);
      const agentId = str(row?.agentId);
      const provider = readVoiceProviderId(row?.provider);
      if (agentId && provider) {
        overrides.push({ agentId, provider });
      }
    }
  }
  const effectiveRecord = asRecord(record.effective);
  const effectiveProvider = readVoiceProviderId(effectiveRecord?.provider);
  const effectiveAgent = str(effectiveRecord?.agentId);
  return {
    providers,
    systemDefault:
      readVoiceProviderId(record.systemDefault) ??
      VOICE_SYSTEM_DEFAULT_PROVIDER,
    userDefault: readVoiceProviderId(record.userDefault),
    agentOverrides: overrides,
    revision: revisionOf(record.revision),
    effective:
      effectiveRecord && effectiveProvider && effectiveAgent
        ? {
            agentId: effectiveAgent,
            provider: effectiveProvider,
            source: sourceOf(effectiveRecord.source),
            available: effectiveRecord.available !== false,
            fallbackFrom: readVoiceProviderId(effectiveRecord.fallbackFrom),
            fallbackReason: str(effectiveRecord.fallbackReason),
            model: str(effectiveRecord.model),
            voice: str(effectiveRecord.voice),
            thinkingLevel: str(effectiveRecord.thinkingLevel),
            revision: revisionOf(effectiveRecord.revision),
          }
        : null,
  };
};

/** The caller's own override for one agent, or null. */
export const voiceAgentOverride = (
  settings: VoiceSettings,
  agentId: string,
): VoiceProviderId | null =>
  settings.agentOverrides.find(
    (row) => row.agentId.toLowerCase() === agentId.toLowerCase(),
  )?.provider ?? null;

export const voiceProviderLabel = (
  settings: VoiceSettings | null | undefined,
  id: VoiceProviderId,
): string =>
  settings?.providers.find((option) => option.id === id)?.label ??
  VOICE_PROVIDER_FALLBACK_LABELS[id];

/** The start response's `provider` (§9.3). */
export type VoiceStartProvider = {
  id: VoiceProviderId;
  model: string | null;
  source: VoiceProviderSource;
  fallbackFrom: VoiceProviderId | null;
  fallbackReason: VoiceProviderUnavailableReason | null;
  voice: string | null;
  thinkingLevel: string | null;
};

export const parseVoiceStartProvider = (
  value: unknown,
): VoiceStartProvider | null => {
  const record = asRecord(value);
  const id = readVoiceProviderId(record?.id);
  if (!record || !id) {
    return null;
  }
  return {
    id,
    model: str(record.model),
    source: sourceOf(record.source),
    fallbackFrom: readVoiceProviderId(record.fallbackFrom),
    fallbackReason: str(record.fallbackReason),
    voice: str(record.voice),
    thinkingLevel: str(record.thinkingLevel),
  };
};

/**
 * The call card's quiet provider line: "Voice: Gemini", or "Voice: GPT-Live
 * (Gemini unavailable)" after an inherited choice fell back. Null for an
 * ordinary GPT-Live call, which says nothing.
 */
export const voiceProviderLine = (
  provider: Pick<VoiceStartProvider, "id" | "fallbackFrom"> | null,
  label: (id: VoiceProviderId) => string = (id) =>
    VOICE_PROVIDER_FALLBACK_LABELS[id],
): string | null => {
  if (!provider) {
    return null;
  }
  if (provider.fallbackFrom && provider.fallbackFrom !== provider.id) {
    return `Voice: ${label(provider.id)} (${label(provider.fallbackFrom)} unavailable)`;
  }
  return provider.id === "gemini" ? `Voice: ${label(provider.id)}` : null;
};
