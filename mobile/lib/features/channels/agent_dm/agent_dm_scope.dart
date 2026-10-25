import 'package:flutter/widgets.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../../../shared/agent_dm/agent_dm_markers.dart';
import '../../../shared/relay/relay.dart';
import '../channel.dart';
import '../channel_management_provider.dart';
import '../timeline_message.dart';
import 'agent_dm_call_card_row.dart';
import 'agent_dm_message_footer.dart';
import 'agent_dm_mirror_badge.dart';
import 'agent_dm_session_divider_row.dart';
import 'agent_dm_sessions_listing_row.dart';
import 'agent_dm_timeline.dart';

/// Indexes the agent DM markers of [channel]'s loaded [events].
///
/// Membership comes from the channel's member list once it loads, and from
/// the DM's participant keys before that. Outside a DM this is
/// [AgentDmTimeline.empty].
AgentDmTimeline useAgentDmTimeline(
  WidgetRef ref, {
  required Channel channel,
  required List<NostrEvent>? events,
  required String? currentPubkey,
  required Set<String> agentPubkeys,
}) {
  final members = channel.isDm
      ? ref
                .watch(channelMembersProvider(channel.id))
                .value
                ?.map((member) => member.pubkey)
                .toList() ??
            channel.participantPubkeys
      : const <String>[];
  return useMemoized(
    () => AgentDmTimeline.build(
      events: events ?? const [],
      isDm: channel.isDm,
      memberPubkeys: members,
      currentPubkey: currentPubkey,
      agentPubkeys: agentPubkeys,
    ),
    [
      events,
      channel.isDm,
      Object.hashAll(members),
      currentPubkey,
      Object.hashAllUnordered(agentPubkeys),
    ],
  );
}

/// Gives a DM timeline's rows its agent DM markers.
class AgentDmScope extends InheritedWidget {
  /// The indexed markers.
  final AgentDmTimeline timeline;

  /// The DM the rows belong to; card answers and action taps send here.
  final Channel channel;

  /// Whether the timeline is a personal (Me) chat, which sends through its
  /// own optimistic reader.
  final bool personal;

  const AgentDmScope({
    super.key,
    required this.timeline,
    required this.channel,
    this.personal = false,
    required super.child,
  });

  /// The nearest scope. Pass `listen: false` from callbacks.
  static AgentDmScope? maybeOf(BuildContext context, {bool listen = true}) =>
      listen
      ? context.dependOnInheritedWidgetOfExactType<AgentDmScope>()
      : context.getInheritedWidgetOfExactType<AgentDmScope>();

  /// The lowercase author key shown for [message]; the signer unless a
  /// requester mirror names another member of the DM.
  static String authorOf(BuildContext context, TimelineMessage message) =>
      maybeOf(context)?.timeline.authorOf(message) ??
      message.pubkey.toLowerCase();

  /// The mirror marker on [message], read without subscribing.
  static AgentDmMirror? mirrorOf(
    BuildContext context,
    TimelineMessage message,
  ) => maybeOf(context, listen: false)?.timeline.mirrorOf(message.id);

  /// A full-width row replacing [message], for session dividers and
  /// listings; null for every other message.
  static Widget? rowFor(BuildContext context, TimelineMessage message) {
    final timeline = maybeOf(context)?.timeline;
    if (timeline == null) return null;
    final call = timeline.callOf(message.id);
    if (call != null) {
      return AgentDmCallCardRow(
        key: ValueKey('agent-dm-call-${message.id}'),
        call: call,
        content: message.content,
      );
    }
    final divider = timeline.dividerOf(message.id);
    if (divider != null) {
      return AgentDmSessionDividerRow(
        key: ValueKey('agent-dm-divider-${message.id}'),
        divider: divider,
        caption: message.content,
      );
    }
    final listing = timeline.listingOf(message.id);
    if (listing != null) {
      return AgentDmSessionsListingRow(
        key: ValueKey('agent-dm-listing-${message.id}'),
        listing: listing.listing,
        fallbackText: message.content,
      );
    }
    return null;
  }

  /// The "via email" badge line above a mirrored [message], or null.
  static Widget? mirrorMetaFor(BuildContext context, TimelineMessage message) {
    final scope = maybeOf(context);
    final mirror = scope?.timeline.mirrorOf(message.id);
    if (scope == null || mirror == null) return null;
    return AgentDmMirrorBadge(
      key: ValueKey('agent-dm-mirror-${message.id}'),
      mirror: mirror,
      channelId: scope.channel.id,
      signerPubkey: message.pubkey,
      relayed: scope.timeline.isRelayed(message),
    );
  }

  /// The agent card, question card and action buttons under [message], or
  /// null.
  static Widget? footerFor(BuildContext context, TimelineMessage message) {
    final timeline = maybeOf(context)?.timeline;
    if (timeline == null) return null;
    if (timeline.questionOf(message.id) == null &&
        timeline.actionsOf(message.id).isEmpty &&
        timeline.surfaceOf(message.id) == null) {
      return null;
    }
    return AgentDmMessageFooter(
      key: ValueKey('agent-dm-footer-${message.id}'),
      messageId: message.id,
    );
  }

  @override
  bool updateShouldNotify(AgentDmScope oldWidget) =>
      !identical(timeline, oldWidget.timeline) ||
      channel.id != oldWidget.channel.id ||
      personal != oldWidget.personal;
}
