import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../../../shared/agent_dm/agent_dm_session_setup.dart';
import '../../../shared/theme/buzz_icons.dart';
import '../../../shared/theme/theme.dart';
import '../../../shared/widgets/modal_presentation.dart';

/// The row re-reads the panel this often while the DM shows.
const _refresh = Duration(seconds: 60);

/// The line above a 1:1 hosted agent DM's composer: the session's model,
/// level and context, opening its panel, and Stop while the agent works.
/// Nothing shows for an agent with no host.
class AgentDmSessionRow extends HookConsumerWidget {
  const AgentDmSessionRow({
    super.key,
    required this.agentPubkey,
    required this.working,
  });

  /// The agent's lowercase key.
  final String agentPubkey;

  /// The agent is working now ("is typing…").
  final bool working;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final provider = agentDmSessionSetupProvider(agentPubkey);
    final setup = ref.watch(provider).value;
    useEffect(() {
      final timer = Timer.periodic(_refresh, (_) {
        final state = WidgetsBinding.instance.lifecycleState;
        if (state == AppLifecycleState.resumed) ref.invalidate(provider);
      });
      return timer.cancel;
    }, [agentPubkey]);
    final stopping = useState(false);
    if (setup == null) return const SizedBox.shrink();
    final messenger = ScaffoldMessenger.maybeOf(context);

    Future<void> stop() async {
      stopping.value = true;
      final String text;
      try {
        text = switch (await ref
            .read(agentDmSessionActionsProvider)
            .stop(agentPubkey)) {
          AgentDmStopOutcome.stopping => 'Stopping…',
          AgentDmStopOutcome.stopped => 'Stopped.',
          AgentDmStopOutcome.notRunning => 'Nothing is running to stop.',
        };
      } catch (error) {
        debugPrint('[AgentDmSession] stop failed: ${error.runtimeType}');
        messenger?.showSnackBar(
          const SnackBar(content: Text("Couldn't stop the agent. Try again.")),
        );
        return;
      } finally {
        if (context.mounted) stopping.value = false;
      }
      messenger?.showSnackBar(SnackBar(content: Text(text)));
    }

    final text = setup.shortText;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: Grid.twelve),
      child: Row(
        children: [
          Expanded(
            child: Semantics(
              container: true,
              button: true,
              excludeSemantics: true,
              label: 'Session: $text',
              onTap: () =>
                  unawaited(showAgentDmSessionSheet(context, agentPubkey)),
              child: InkWell(
                key: const ValueKey('agent-dm-session-row'),
                borderRadius: BorderRadius.circular(Radii.sm),
                onTap: () =>
                    unawaited(showAgentDmSessionSheet(context, agentPubkey)),
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: Grid.half,
                    vertical: Grid.half,
                  ),
                  child: Text(
                    text,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: context.textTheme.labelSmall?.copyWith(
                      color: context.colors.onSurfaceVariant,
                    ),
                  ),
                ),
              ),
            ),
          ),
          if (working)
            TextButton.icon(
              key: const ValueKey('agent-dm-stop'),
              onPressed: stopping.value ? null : () => unawaited(stop()),
              icon: const Icon(BuzzIcons.square, size: 14),
              label: const Text('Stop'),
              style: TextButton.styleFrom(
                visualDensity: VisualDensity.compact,
                tapTargetSize: MaterialTapTargetSize.padded,
              ),
            ),
        ],
      ),
    );
  }
}

/// Opens the session's panel: its vitals and the model and level picks.
Future<void> showAgentDmSessionSheet(
  BuildContext context,
  String agentPubkey,
) => showBuzzModalBottomSheet<void>(
  context: context,
  title: 'Session',
  isScrollControlled: true,
  builder: (_) => _AgentDmSessionSheet(agentPubkey: agentPubkey),
);

/// Carries out a typed session command: a clear pick changes the session, and
/// anything else opens the panel.
Future<void> runAgentDmSetupCommand(
  BuildContext context,
  WidgetRef ref,
  String agentPubkey,
  AgentDmSessionSetup setup,
  AgentDmSetupCommand command,
) async {
  final arg = command.arg;
  final pick = arg == null
      ? null
      : switch (command.name) {
          'model' => resolveAgentDmModelArg(setup, arg),
          'effort' => resolveAgentDmEffortArg(setup, arg),
          _ => null,
        };
  if (pick == null) {
    await showAgentDmSessionSheet(context, agentPubkey);
    return;
  }
  final messenger = ScaffoldMessenger.maybeOf(context);
  String text;
  try {
    final next = await ref.read(agentDmSessionActionsProvider).change(
      agentPubkey,
      setup,
      {command.name: pick.id},
    );
    final shown = command.name == 'model'
        ? next.models
                  .where((model) => model.id == next.model)
                  .firstOrNull
                  ?.label ??
              next.model
        : next.effortLabel(next.effort);
    text = '$shown applies from the next turn.';
  } catch (error) {
    text = agentDmSetupChangeErrorSentence(error);
  }
  messenger?.showSnackBar(SnackBar(content: Text(text)));
}

class _AgentDmSessionSheet extends HookConsumerWidget {
  const _AgentDmSessionSheet({required this.agentPubkey});

  final String agentPubkey;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final setup = ref.watch(agentDmSessionSetupProvider(agentPubkey)).value;
    final saving = useState(false);
    if (setup == null) return const SizedBox.shrink();
    final messenger = ScaffoldMessenger.maybeOf(context);

    Future<void> choose(Map<String, String?> choice) async {
      saving.value = true;
      try {
        await ref
            .read(agentDmSessionActionsProvider)
            .change(agentPubkey, setup, choice);
      } catch (error) {
        messenger?.showSnackBar(
          SnackBar(content: Text(agentDmSetupChangeErrorSentence(error))),
        );
      } finally {
        if (context.mounted) saving.value = false;
      }
    }

    Widget heading(String text) => Padding(
      padding: const EdgeInsets.fromLTRB(
        Grid.xs,
        Grid.twelve,
        Grid.xs,
        Grid.half,
      ),
      child: Semantics(
        header: true,
        child: Text(
          text,
          style: context.textTheme.labelMedium?.copyWith(
            color: context.colors.onSurfaceVariant,
          ),
        ),
      ),
    );

    Widget choice(String label, bool selected, VoidCallback onChoose) =>
        ListTile(
          dense: true,
          selected: selected,
          title: Text(label),
          trailing: selected ? const Icon(BuzzIcons.check, size: 18) : null,
          onTap: saving.value || selected ? null : onChoose,
        );

    final vitals = setup.vitals;
    final lines = vitals == null
        ? const <String>[]
        : agentDmVitalsLines(vitals);
    final efforts = setup.currentEfforts;
    return SafeArea(
      child: ListView(
        key: const ValueKey('agent-dm-session-sheet'),
        shrinkWrap: true,
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: Grid.xs),
            child: Text(setup.label, style: context.textTheme.titleSmall),
          ),
          if (setup.canChangeModel && setup.models.isNotEmpty) ...[
            heading('Model'),
            for (final model in setup.models)
              choice(
                model.label,
                model.id == setup.model,
                () => unawaited(choose({'model': model.id})),
              ),
          ],
          if (setup.canChangeEffort && efforts.isNotEmpty) ...[
            heading('Reasoning'),
            for (final effort in efforts)
              choice(
                setup.effortLabel(effort),
                effort == setup.effort,
                () => unawaited(choose({'effort': effort})),
              ),
          ],
          if (setup.canChangeModel || setup.canChangeEffort)
            Padding(
              padding: const EdgeInsets.fromLTRB(Grid.xs, Grid.xxs, Grid.xs, 0),
              child: Text(
                'A change applies from the next turn.',
                style: context.textTheme.bodySmall?.copyWith(
                  color: context.colors.onSurfaceVariant,
                ),
              ),
            ),
          if (lines.isNotEmpty) ...[
            heading('Vitals'),
            for (final line in lines)
              Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: Grid.xs,
                  vertical: Grid.quarter,
                ),
                child: Text(line, style: context.textTheme.bodySmall),
              ),
          ],
          const SizedBox(height: Grid.xs),
        ],
      ),
    );
  }
}
