import 'package:flutter/widgets.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:nostr/nostr.dart' as nostr;

import '../../../shared/agent_dm/agent_dm_markers.dart';
import '../../../shared/relay/relay.dart';
import '../channel.dart';
import 'agent_dm_scope.dart';

/// Installs the DM's [AgentDmScope] on a pushed thread route, which does not
/// inherit the channel page's scope, so mirrored lines in a thread keep the
/// shared display rule (relay line, relayed frame, signer for managing).
///
/// [channel] is null until the channel list loads; [child] then renders
/// without markers, as any non-DM thread does.
class AgentDmThreadScope extends StatelessWidget {
  /// The thread's channel, if known.
  final Channel? channel;

  /// The thread's events (replies and the live channel events, which carry
  /// the head).
  final List<NostrEvent> events;

  /// The reader.
  final String? currentPubkey;

  /// Keys known to be agents in this channel.
  final Set<String> agentPubkeys;

  /// The thread view.
  final Widget child;

  const AgentDmThreadScope({
    super.key,
    required this.channel,
    required this.events,
    required this.currentPubkey,
    required this.agentPubkeys,
    required this.child,
  });

  @override
  Widget build(BuildContext context) {
    final channel = this.channel;
    if (channel == null || !channel.isDm) return child;
    return _DmThreadScope(
      channel: channel,
      events: events,
      currentPubkey: currentPubkey,
      agentPubkeys: agentPubkeys,
      child: child,
    );
  }
}

class _DmThreadScope extends HookConsumerWidget {
  final Channel channel;
  final List<NostrEvent> events;
  final String? currentPubkey;
  final Set<String> agentPubkeys;
  final Widget child;

  const _DmThreadScope({
    required this.channel,
    required this.events,
    required this.currentPubkey,
    required this.agentPubkeys,
    required this.child,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) => AgentDmScope(
    timeline: useAgentDmTimeline(
      ref,
      channel: channel,
      events: events,
      currentPubkey: currentPubkey,
      agentPubkeys: agentPubkeys,
    ),
    channel: channel,
    child: child,
  );
}

/// Whether [tags] carry a mirror marker, so a thread head with them needs its
/// event for the shared display rule.
bool agentDmHeadNeedsEvent(List<List<String>> tags) =>
    tags.any((tag) => tag.isNotEmpty && tag.first == 'buzz-mirror');

/// The head event of a DM thread whose head neither the channel window nor
/// the replies query holds (a deep link to a mirror's thread, or a head that
/// left the channel window). Only a kind 40002 event in [channelId] with
/// exactly the requested id, signed by the head's own [pubkey], whose id and
/// signature verify, is returned; anything else is null, and the head then
/// renders as before. The relay session does not verify the events it
/// returns, so this check does.
final agentDmThreadHeadProvider = FutureProvider.autoDispose
    .family<NostrEvent?, ({String channelId, String eventId, String pubkey})>((
      ref,
      args,
    ) async {
      final events = await ref
          .read(relaySessionProvider.notifier)
          .fetchHistory(
            NostrFilter(
              kinds: const [agentDmQuietKind],
              ids: [args.eventId],
              tags: {
                '#h': [args.channelId],
              },
              limit: 1,
            ),
          );
      for (final event in events) {
        if (agentDmThreadHeadMatches(
          event,
          channelId: args.channelId,
          eventId: args.eventId,
          pubkey: args.pubkey,
        )) {
          return event;
        }
      }
      return null;
    });

/// Whether [event] is the thread head asked for: kind 40002 in [channelId],
/// exactly [eventId], signed by [pubkey] (the head's own signer), with an id
/// and signature that verify.
bool agentDmThreadHeadMatches(
  NostrEvent event, {
  required String channelId,
  required String eventId,
  required String pubkey,
}) {
  final inChannel = event.tags.any(
    (tag) => tag.length >= 2 && tag[0] == 'h' && tag[1] == channelId,
  );
  if (event.id != eventId ||
      event.kind != agentDmQuietKind ||
      event.pubkey.toLowerCase() != pubkey.trim().toLowerCase() ||
      !inChannel) {
    return false;
  }
  return nostr.Event(
    event.id,
    event.pubkey,
    event.createdAt,
    event.kind,
    event.tags,
    event.content,
    event.sig,
    verify: false,
  ).isValid();
}
