import 'dart:async';

import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../../../shared/hosted_agents/session_controls.dart';
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

/// The agent whose sessions picker the DM header offers, or null. Besides a
/// 1:1 DM with an agent ([agentDmSessionsPeer]), the server must say session
/// controls are on for that agent; until it answers, and after any failed
/// check, there is no picker. Asked lazily, only for such a DM.
String? watchAgentDmSessionsAgent(
  WidgetRef ref, {
  required Channel channel,
  required String? currentPubkey,
  required Set<String> agentPubkeys,
}) {
  final peer = agentDmSessionsPeer(
    channel: channel,
    currentPubkey: currentPubkey,
    agentPubkeys: agentPubkeys,
  );
  if (peer == null) return null;
  final available = ref.watch(agentSessionControlsProvider(peer)).value;
  return available == true ? peer : null;
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
