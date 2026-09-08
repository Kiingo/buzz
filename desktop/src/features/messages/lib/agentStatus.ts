import { KIND_AGENT_STATUS } from "@/shared/constants/kinds";

const STATES = new Set([
  "receipt",
  "progress",
  "capacity",
  "error",
  "cancelled",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_ID = /^[0-9a-f]{64}$/i;

/** Parse only the operational protocol. Actor identity always comes from the
 * signed event; relay moderation JSON and chat text cannot enter this renderer. */
export function parseAgentStatus(event: {
  kind?: number;
  content: string;
  tags?: string[][];
}): { text: string; state: string; receiptId: string; rootId: string } | null {
  if (event.kind !== KIND_AGENT_STATUS) return null;
  const tags = event.tags ?? [];
  if (tags.length !== 3) return null;
  const channel = tags.filter((tag) => tag[0] === "h");
  const thread = tags.filter((tag) => tag[0] === "e");
  const fence = tags.filter((tag) => tag[0] === "d");
  if (
    channel.length !== 1 ||
    channel[0].length !== 2 ||
    !UUID.test(channel[0][1]) ||
    thread.length !== 1 ||
    thread[0].length !== 4 ||
    !EVENT_ID.test(thread[0][1]) ||
    thread[0][2] !== "" ||
    thread[0][3] !== "reply" ||
    fence.length !== 1 ||
    fence[0].length !== 2 ||
    !fence[0][1].trim() ||
    fence[0][1].length > 256
  )
    return null;
  try {
    const payload = JSON.parse(event.content);
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      Object.keys(payload).sort().join(",") !==
        "receipt_id,state,text,version" ||
      payload.version !== 1 ||
      typeof payload.receipt_id !== "string" ||
      !UUID.test(payload.receipt_id) ||
      !STATES.has(payload.state) ||
      typeof payload.text !== "string" ||
      !payload.text.trim() ||
      new TextEncoder().encode(payload.text).length > 64 * 1024
    )
      return null;
    return {
      text: payload.text,
      state: payload.state,
      receiptId: payload.receipt_id,
      rootId: thread[0][1],
    };
  } catch {
    return null;
  }
}
