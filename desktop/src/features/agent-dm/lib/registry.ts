/**
 * Community-scoped client memory for agent DM cards: question cards this
 * client answered and messages whose action buttons were used. Rows read it
 * with `useSyncExternalStore`; `resetAgentDmState()` clears it on community
 * switch (wired into resetCommunityState()).
 */

let answeredQuestionIds = new Set<string>();
let usedActionMessageIds = new Set<string>();
let version = 0;
const listeners = new Set<() => void>();

function notify() {
  version += 1;
  for (const listener of listeners) listener();
}

export function markQuestionAnsweredLocally(questionMessageId: string) {
  if (answeredQuestionIds.has(questionMessageId)) return;
  answeredQuestionIds.add(questionMessageId);
  notify();
}

export function isQuestionAnsweredLocally(questionMessageId: string) {
  return answeredQuestionIds.has(questionMessageId);
}

export function markActionsUsed(messageId: string) {
  if (usedActionMessageIds.has(messageId)) return;
  usedActionMessageIds.add(messageId);
  notify();
}

export function areActionsUsed(messageId: string) {
  return usedActionMessageIds.has(messageId);
}

export function subscribeAgentDmState(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getAgentDmStateVersion() {
  return version;
}

export function resetAgentDmState() {
  answeredQuestionIds = new Set();
  usedActionMessageIds = new Set();
  notify();
}
