import type { UnlinkedAgent } from "./relink";

/**
 * Agents the create form offers to attach to, in the provider's order
 * (newest first). The native side already leaves out machine defaults and
 * malformed entries; this keeps only distinct, named agents.
 */
export function attachChoices(agents: UnlinkedAgent[]): UnlinkedAgent[] {
  const seen = new Set<string>();
  return agents.filter((agent) => {
    if (!agent.displayName.trim() || seen.has(agent.kiingoAgentId)) {
      return false;
    }
    seen.add(agent.kiingoAgentId);
    return true;
  });
}

/** The picker's choice if it is still on offer, otherwise none. */
export function currentAttachChoice(
  value: string | null | undefined,
  choices: UnlinkedAgent[],
): string | null {
  return value && choices.some((agent) => agent.kiingoAgentId === value)
    ? value
    : null;
}

const ATTACH_FAILURES: [RegExp, string][] = [
  [
    /\b(?:buzz_hosted_)?already_has_buzz_identity\b/,
    "That agent is already on Buzz. Pick another one, or create a new agent.",
  ],
  [
    /\b(?:buzz_hosted_)?not_agent_owner\b/,
    "You can only attach an agent you own. Pick one of yours, or create a new agent.",
  ],
  [
    /\b(?:buzz_hosted_)?agent_spec_required\b/,
    "That agent isn't set up to run yet. Finish setting it up, then try again.",
  ],
  [
    /\b(?:buzz_hosted_)?kiingo_agent_id_invalid\b/,
    "The agent you picked can't be used. Choose it again from the list.",
  ],
];

/**
 * Plain words for a failed start that attached to an existing agent, or
 * null when the failure is not about the attach. The provider reports these
 * as a code in its error text.
 */
export function describeAttachFailure(message: string): string | null {
  for (const [pattern, text] of ATTACH_FAILURES) {
    if (pattern.test(message)) return text;
  }
  return null;
}
