import {
  mirrorDisplay,
  mirrorPlainText,
  type MirrorDisplay,
  type MirrorDisplayNames,
} from "@/features/agent-dm/lib/mirrorDisplay";
import type { DmChannelLike } from "@/features/agent-dm/lib/markers";
import type { SearchHit } from "@/shared/api/types";

/**
 * The shared mirror display rule for a search hit: a mirrored DM line is
 * listed under the agent that signed it and its preview is the relayed plain
 * form ("Alex (via Kiingo Tasks, relayed by Agent): text"), never as its
 * displayed author's own words. Null for any other hit.
 */
export function searchHitMirror({
  hit,
  channel,
  names,
  signerIsAgent,
}: {
  hit: Pick<SearchHit, "kind" | "pubkey" | "tags">;
  channel: DmChannelLike | null | undefined;
  names: MirrorDisplayNames;
  signerIsAgent: boolean;
}): MirrorDisplay | null {
  return mirrorDisplay({
    event: { kind: hit.kind, pubkey: hit.pubkey, tags: hit.tags },
    channel,
    names,
    signerIsAgent,
  });
}

/** The text a search hit's preview is built from. */
export function searchHitPreviewText(
  hit: Pick<SearchHit, "content">,
  mirror: MirrorDisplay | null,
) {
  return mirror ? mirrorPlainText(mirror, hit.content) : hit.content;
}
