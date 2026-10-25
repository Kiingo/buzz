import 'dart:async';

import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../../../shared/agent_dm/agent_dm_answers.dart';
import '../../../shared/agent_dm/agent_dm_markers.dart';
import 'agent_dm_action_buttons.dart';
import 'agent_dm_question_card.dart';
import 'agent_dm_scope.dart';
import 'agent_dm_sent_provider.dart';
import 'agent_dm_surface_card.dart';
import 'agent_dm_timeline.dart';

/// The card state from the loaded events and this client's own sends.
/// Answered wins over closed; a send in flight pauses an open card.
AgentDmCardState agentDmCardState(
  AgentDmQuestionStatus status,
  AgentDmSendStatus? local,
) {
  if (status == AgentDmQuestionStatus.answered ||
      local == AgentDmSendStatus.sent) {
    return AgentDmCardState.answered;
  }
  if (status == AgentDmQuestionStatus.closed) return AgentDmCardState.closed;
  if (local == AgentDmSendStatus.sending) return AgentDmCardState.sending;
  return AgentDmCardState.open;
}

/// The agent card, question card and action buttons under one agent
/// message, wired to the DM's send path.
class AgentDmMessageFooter extends ConsumerWidget {
  /// The agent message.
  final String messageId;

  const AgentDmMessageFooter({super.key, required this.messageId});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final scope = AgentDmScope.maybeOf(context);
    if (scope == null) return const SizedBox.shrink();
    final timeline = scope.timeline;
    final channelId = scope.channel.id;
    final card = timeline.questionOf(messageId);
    final actions = timeline.actionsOf(messageId);
    final surface = timeline.surfaceOf(messageId);
    final sent = ref.watch(agentDmSentProvider);
    final answerKey = card == null
        ? null
        : agentDmAnswerKey(channelId, card.askId);
    final actionKey = agentDmActionKey(channelId, messageId);
    final actionsEnabled =
        !timeline.actionsUsed(messageId) && !sent.containsKey(actionKey);

    Future<void> deliver(
      String key,
      String content,
      List<List<String>> tags,
    ) async {
      final current = AgentDmScope.maybeOf(context, listen: false);
      if (current == null) return;
      final messenger = ScaffoldMessenger.maybeOf(context);
      try {
        await ref
            .read(agentDmSentProvider.notifier)
            .send(
              key,
              () => sendAgentDmMessage(
                ref,
                channel: current.channel,
                content: content,
                tags: tags,
                personal: current.personal,
              ),
            );
      } catch (error) {
        debugPrint('[AgentDm] send failed: $error');
        messenger?.showSnackBar(
          const SnackBar(content: Text("Couldn't send. Try again.")),
        );
      }
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (surface != null) AgentDmSurfaceCard(surface: surface),
        if (card != null && answerKey != null)
          AgentDmQuestionCardView(
            card: card,
            state: agentDmCardState(
              timeline.questionStatusOf(messageId),
              sent[answerKey],
            ),
            onSubmit: (AgentDmAnswer answer) =>
                unawaited(deliver(answerKey, answer.content, answer.tags)),
          ),
        if (actions.isNotEmpty)
          AgentDmActionButtons(
            actions: actions,
            enabled: actionsEnabled,
            onTap: (AgentDmAction action) => unawaited(
              deliver(actionKey, action.sendText, agentDmActionRefTags(action)),
            ),
          ),
      ],
    );
  }
}
