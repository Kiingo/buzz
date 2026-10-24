/** Route a notification from the audio socket belonging to the current huddle. */
export function huddleAudioDisconnectAction(
  payload: unknown,
  activeChannelId: string | null,
): "ignore" | "leave" | "retry" {
  if (!activeChannelId) return "ignore";
  if (payload && typeof payload === "object" && "channelId" in payload) {
    if (payload.channelId !== activeChannelId) return "ignore";
    if ("terminal" in payload && payload.terminal === true) return "leave";
  }
  // Legacy backends emitted an empty payload for recoverable disconnects.
  return "retry";
}
