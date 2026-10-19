import '../../shared/agent_dm/agent_dm_quiet.dart';
import '../../shared/relay/relay.dart';
import '../channels/channel.dart';

/// A predicate for quiet agent DM events in [channels]' DMs. Quiet events
/// never become an inbox mention, even when they carry a `p` tag.
bool Function(NostrEvent event) quietAgentDmFeedFilter(
  Iterable<Channel> channels,
) {
  final membersByDm = {
    for (final channel in channels)
      if (channel.isDm) channel.id: channel.participantPubkeys,
  };
  return (event) {
    final members = membersByDm[event.channelId];
    return members != null &&
        isQuietAgentDmEvent(event, isDm: true, memberPubkeys: members);
  };
}
