import 'dart:async';

import 'package:flutter/material.dart';

import '../../../shared/theme/buzz_icons.dart';
import '../../../shared/theme/theme.dart';
import '../../../shared/widgets/ios_navigation_bar.dart';
import '../channel.dart';
import 'agent_dm_sessions_picker.dart';

/// The agent in a 1:1 DM between the reader and an agent, or null for any
/// other conversation. The sessions picker appears only when this is set.
String? agentDmSessionsPeer({
  required Channel channel,
  required String? currentPubkey,
  required Set<String> agentPubkeys,
}) {
  final self = currentPubkey?.trim().toLowerCase();
  if (!channel.isDm || self == null || self.isEmpty) return null;
  final participants = {
    for (final pubkey in channel.participantPubkeys)
      if (pubkey.trim().isNotEmpty) pubkey.trim().toLowerCase(),
  };
  if (participants.length != 2 || !participants.remove(self)) return null;
  final peer = participants.single;
  final agents = {for (final pubkey in agentPubkeys) pubkey.toLowerCase()};
  return agents.contains(peer) ? peer : null;
}

/// The native header item that opens the sessions picker.
IosNavigationAction agentDmSessionsNavigationAction(
  BuildContext context, {
  required Channel channel,
  required String agentPubkey,
}) => IosNavigationAction(
  label: 'Sessions',
  symbol: 'clock.arrow.circlepath',
  onPressed: () => unawaited(
    showAgentDmSessionsPicker(
      context,
      channel: channel,
      agentPubkey: agentPubkey,
    ),
  ),
);

/// The header button that opens the sessions picker.
class AgentDmSessionsButton extends StatelessWidget {
  /// The 1:1 DM with the agent.
  final Channel channel;

  /// The agent's key.
  final String agentPubkey;

  const AgentDmSessionsButton({
    super.key,
    required this.channel,
    required this.agentPubkey,
  });

  @override
  Widget build(BuildContext context) {
    void open() => unawaited(
      showAgentDmSessionsPicker(
        context,
        channel: channel,
        agentPubkey: agentPubkey,
      ),
    );
    return Semantics(
      container: true,
      button: true,
      label: 'Sessions',
      excludeSemantics: true,
      onTap: open,
      child: IconButton(
        key: const ValueKey('agent-dm-sessions-button'),
        color: context.colors.primary,
        onPressed: open,
        tooltip: 'Sessions',
        icon: const Icon(BuzzIcons.clockFading, size: 22),
      ),
    );
  }
}
