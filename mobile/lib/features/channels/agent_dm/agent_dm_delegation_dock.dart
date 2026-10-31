import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../shared/agent_dm/agent_dm_delegation_client.dart';
import '../../../shared/agent_dm/agent_dm_delegations.dart';
import '../../../shared/agent_dm/agent_dm_markers.dart';
import '../../../shared/theme/buzz_icons.dart';
import '../../../shared/theme/theme.dart';
import 'agent_dm_question_card.dart';

part 'agent_dm_delegation_dock/delegation_rows.dart';

/// Hidden done summaries, per viewer (a convenience; not shared).
const _hiddenKey = 'buzz.agentDelegations.hiddenDone.v1';
const _hiddenMax = 500;

/// Running cards re-read their elapsed time this often.
const _tick = Duration(seconds: 30);

/// The agent's delegations, docked above the composer of the owner's 1:1
/// DM (§10.1). While the agent's reply is on its way it opens with the
/// server's pending ack ("Starting 2 workers: …"), then the thread header
/// ("3 running · 1 needs you · $4.10 today") and Stop all, then worker asks ("from worker: <title>",
/// the same question card the agent's own asks use, answered straight to
/// the worker), the running cards (folded at three or more) and one done
/// summary per task. Cards update in place and never become messages.
///
/// The host answers only the agent's owner (D5), so anyone else sees
/// nothing here.
class AgentDmDelegationDock extends HookConsumerWidget {
  /// The agent of the reader's own 1:1 DM (lowercase hex).
  final String agentPubkey;

  const AgentDmDelegationDock({super.key, required this.agentPubkey});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final provider = delegationBoardProvider(agentPubkey);
    final board = ref.watch(provider);
    final hidden = useState<Set<String>>(useMemoized(() => _readHidden(ref)));
    final expanded = useState(false);
    final now = useState(DateTime.now());
    final ready = board is DelegationBoardReady ? board : null;
    final view = ready == null
        ? null
        : delegationBoard(ready.page.cards, hidden: hidden.value);
    final ticking = view != null && view.running.isNotEmpty;
    useEffect(() {
      if (!ticking) return null;
      final timer = Timer.periodic(_tick, (_) => now.value = DateTime.now());
      return timer.cancel;
    }, [ticking]);
    if (ready == null || view == null) return const SizedBox.shrink();
    final header = delegationHeaderText(ready.page.summary);
    final ack = ready.ack;
    if (ack == null && view.isEmpty && header == null) {
      return const SizedBox.shrink();
    }

    final notifier = ref.read(provider.notifier);
    final messenger = ScaffoldMessenger.maybeOf(context);
    final appOrigin = delegationAppOrigin(
      ref.watch(delegationClientProvider)?.origin,
    );

    void say(String text) =>
        messenger?.showSnackBar(SnackBar(content: Text(text)));

    Future<void> open(String url) async {
      final uri = Uri.tryParse(url);
      var opened = false;
      if (uri != null) {
        try {
          opened = await launchUrl(uri, mode: LaunchMode.externalApplication);
        } catch (error) {
          debugPrint('[Delegations] link failed: ${error.runtimeType}');
        }
      }
      if (!opened) say("Couldn't open that link.");
    }

    Future<void> stopAll() async {
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('Stop all workers?'),
          content: Text(
            'Every worker '
            '${ready.page.agentName.isEmpty ? 'this agent' : ready.page.agentName}'
            ' started stops its current turn. Their sessions are kept, so '
            'the work can be picked up again.',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Cancel'),
            ),
            TextButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Stop all'),
            ),
          ],
        ),
      );
      if (confirmed != true) return;
      try {
        final stopped = await notifier.cancelAll();
        say(stopped == 1 ? 'Stopped 1 worker.' : 'Stopped $stopped workers.');
      } on Object {
        say("Couldn't stop the workers. Try again.");
      }
    }

    void stop(DelegationCard card) {
      unawaited(
        notifier
            .cancel(card.delegationId)
            .catchError(
              (Object _) => say("Couldn't stop that worker. Try again."),
            ),
      );
    }

    void hide(String key) {
      final next = {...hidden.value, key};
      hidden.value = next;
      _writeHidden(ref, next);
    }

    Widget row(DelegationCard card) => _DelegationCardRow(
      key: ValueKey('delegation-${card.delegationId}'),
      card: card,
      elapsed: formatDelegationElapsed(
        delegationLiveElapsed(card, ready.page.serverNow, now.value),
      ),
      onStop: () => stop(card),
    );

    return Padding(
      padding: const EdgeInsets.fromLTRB(Grid.xxs, 0, Grid.xxs, Grid.half),
      child: DecoratedBox(
        key: const ValueKey('agent-dm-delegation-dock'),
        decoration: BoxDecoration(
          color: context.colors.surfaceContainerLow,
          border: Border.all(color: context.colors.outlineVariant),
          borderRadius: BorderRadius.circular(Radii.lg),
        ),
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxHeight: MediaQuery.sizeOf(context).height * 0.4,
          ),
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(
              horizontal: Grid.twelve,
              vertical: Grid.xxs,
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: [
                if (ack != null)
                  _PendingAckRow(
                    agentName: ready.page.agentName,
                    text: ack.text,
                  ),
                if (header != null)
                  _BoardHeader(
                    text: header,
                    needsYou: ready.page.summary.needsYouCount > 0,
                    canStopAll: ready.page.summary.canStopAll,
                    onStopAll: stopAll,
                  ),
                for (final card in view.needsYou)
                  ...switch (ready.asks[card.delegationId]) {
                    final asks? when asks.isNotEmpty => [
                      for (final ask in asks)
                        AgentDmQuestionCardView(
                          key: ValueKey('delegation-ask-${ask.id}'),
                          card: _askCard(ask),
                          state: AgentDmCardState.open,
                          onSubmit: (answer) => unawaited(
                            notifier
                                .answer(ask.id, answer.content)
                                .catchError(
                                  (Object _) =>
                                      say("Couldn't send your answer."),
                                ),
                          ),
                        ),
                    ],
                    _ => [row(card)],
                  },
                if (view.running.isNotEmpty) ...[
                  if (view.folded)
                    _FoldedRow(
                      count: view.running.length,
                      expanded: expanded.value,
                      onToggle: () => expanded.value = !expanded.value,
                    ),
                  if (!view.folded || expanded.value)
                    for (final card in view.running) row(card),
                ],
                for (final summary in view.done)
                  _DoneSummaryRow(
                    key: ValueKey('delegation-done-${summary.key}'),
                    summary: summary,
                    appOrigin: appOrigin,
                    onOpen: open,
                    onHide: () => hide(summary.key),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The done summaries this viewer put away (a convenience: without saved
/// preferences they last as long as the page).
Set<String> _readHidden(WidgetRef ref) {
  try {
    return (ref.read(savedPrefsProvider).getStringList(_hiddenKey) ?? const [])
        .toSet();
  } on Object {
    return <String>{};
  }
}

void _writeHidden(WidgetRef ref, Set<String> keys) {
  final list = keys.toList();
  try {
    unawaited(
      ref
          .read(savedPrefsProvider)
          .setStringList(
            _hiddenKey,
            list.length > _hiddenMax
                ? list.sublist(list.length - _hiddenMax)
                : list,
          ),
    );
  } on Object {
    // Kept for this page only.
  }
}

/// A worker ask as the existing question card: one question, its options
/// (the recommended one described as such) and free text.
AgentDmQuestionCard _askCard(DelegationAsk ask) {
  final label = ask.fromWorkerLabel;
  return AgentDmQuestionCard(
    askId: ask.id,
    questions: [
      AgentDmQuestion(
        qid: 'q',
        text: ask.question,
        header: label.length > 64 ? '${label.substring(0, 63)}…' : label,
        multi: false,
        allowOther: true,
        options: [
          for (final option in ask.options)
            AgentDmQuestionOption(
              label: option,
              description: option == ask.recommendation ? 'Recommended' : '',
            ),
        ],
      ),
    ],
  );
}
