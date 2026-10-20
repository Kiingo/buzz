import '../relay/nostr_models.dart';
import 'agent_dm_markers.dart';

/// The quiet markers a kind-40002 event can carry.
enum AgentDmQuietMarker {
  /// `buzz-mirror`: history copied from another surface.
  mirror,

  /// `buzz-session`: a session divider.
  sessionDivider,

  /// `buzz-sessions`: a sessions listing.
  sessionsListing,

  /// `buzz-question-state`: closes a question card; renders no row.
  questionState,
}

/// The well-formed quiet marker on an event with [kind] and [tags], or null.
AgentDmQuietMarker? agentDmQuietMarkerOf(int kind, List<List<String>> tags) {
  if (kind != agentDmQuietKind) return null;
  if (readAgentDmMirror(tags) != null) return AgentDmQuietMarker.mirror;
  if (readAgentDmSessionDivider(tags) != null) {
    return AgentDmQuietMarker.sessionDivider;
  }
  if (readAgentDmSessionsListing(tags) != null) {
    return AgentDmQuietMarker.sessionsListing;
  }
  if (readAgentDmQuestionState(tags) != null) {
    return AgentDmQuietMarker.questionState;
  }
  return null;
}

/// Whether [event] is a quiet agent DM event: a well-formed quiet marker on
/// kind 40002, in a DM, signed by a member of that DM.
///
/// Quiet events never make a channel or thread unread, never count as a
/// mention or badge, and never raise an activity row or a hidden-DM
/// resurface. They may still advance a channel's recency ordering. The
/// predicate deliberately ignores `p` and `e` tags: a marker that was
/// (incorrectly) addressed is still never a mention.
bool isQuietAgentDmEvent(
  NostrEvent event, {
  required bool isDm,
  required Iterable<String> memberPubkeys,
}) =>
    agentDmQuietMarkerOf(event.kind, event.tags) != null &&
    agentDmMarkersApply(
      isDm: isDm,
      signerPubkey: event.pubkey,
      memberPubkeys: memberPubkeys,
    );
