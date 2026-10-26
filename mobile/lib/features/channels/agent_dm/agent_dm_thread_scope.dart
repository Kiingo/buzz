import 'package:flutter/widgets.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

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
