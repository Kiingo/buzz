import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../../../shared/agent_dm/agent_dm_session_setup.dart';
import '../../../shared/agent_dm/agent_dm_session_views.dart';
import '../../../shared/theme/buzz_icons.dart';
import '../../../shared/theme/theme.dart';
import '../../../shared/widgets/modal_presentation.dart';
import 'agent_dm_session_view_sheet.dart';

/// The row re-reads the panel this often while the DM shows.
const _refresh = Duration(seconds: 60);

/// The line above a 1:1 hosted agent DM's composer: the session's model,
/// level and context, opening its panel, and Stop while the agent works. On
/// a session that runs in a pane, Interrupt is beside Stop: Esc, the running
/// step stops and the session keeps going. Nothing shows for an agent with no
/// host.
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
    final interrupting = useState(false);
    final inPane =
        ref.watch(agentDmSessionBuiltinsProvider(agentPubkey)).value?.inPane ??
        false;
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

    Future<void> interrupt() async {
      interrupting.value = true;
      String text;
      try {
        await ref
            .read(agentDmSessionViewActionsProvider)
            .interrupt(agentPubkey);
        text = 'Interrupted. The session keeps going.';
      } catch (error) {
        text = agentDmSessionViewErrorSentence(error);
      } finally {
        if (context.mounted) interrupting.value = false;
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
          if (working && inPane)
            TextButton(
              key: const ValueKey('agent-dm-interrupt'),
              onPressed: interrupting.value
                  ? null
                  : () => unawaited(interrupt()),
              style: TextButton.styleFrom(
                visualDensity: VisualDensity.compact,
                tapTargetSize: MaterialTapTargetSize.padded,
              ),
              child: const Text('Interrupt'),
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

/// Opens the session's panel: its vitals and the model, level, speed and mode
/// picks, and its read-only views. With [view] ("/" picked `/mcp`, `/diff` …),
/// that view opens instead.
Future<void> showAgentDmSessionSheet(
  BuildContext context,
  String agentPubkey, [
  AgentDmSessionView? view,
]) => view != null
    ? showAgentDmSessionViewSheet(context, agentPubkey, view)
    : showBuzzModalBottomSheet<void>(
        context: context,
        title: 'Session',
        isScrollControlled: true,
        builder: (_) => _AgentDmSessionSheet(agentPubkey: agentPubkey),
      );

/// The panel's read-only views of the session (BUZZPARITY B4).
const _sessionViewRows = [
  ('Files changed', AgentDmSessionView.files()),
  ('Subagents and background tasks', AgentDmSessionView.screen('agents')),
  ('Queued messages', AgentDmSessionView.queued()),
];

/// A whole typed message that is a session command (`/model`, `/status` …) or
/// names one of the session's views (`/mcp`, `/agents`, `/diff` …, as the "/"
/// list has them): carried out here and never sent, as the "/" pick does.
/// False when it stays an ordinary message: another text, an agent with no
/// host, or a view this session doesn't list. A `/clear` this session lists
/// goes to [newSession], the pick's question and then `/new`. [busy] covers the
/// host read; [clear] empties the composer before the panel or view opens.
Future<bool> runAgentDmTypedCommand(
  BuildContext context,
  WidgetRef ref,
  String agentPubkey,
  String text, {
  required void Function(bool busy) busy,
  required void Function() clear,
  required void Function() newSession,
}) async {
  final setupCommand = parseAgentDmSetupCommand(text);
  if (setupCommand == null && !isAgentDmSessionViewShaped(text)) return false;
  busy(true);
  final AgentDmSessionSetup? setup;
  final AgentDmSessionBuiltins? builtins;
  try {
    setup = setupCommand == null
        ? null
        : await ref.read(agentDmSessionSetupProvider(agentPubkey).future);
    builtins = setupCommand != null
        ? null
        : await ref.read(agentDmSessionBuiltinsProvider(agentPubkey).future);
  } finally {
    busy(false);
  }
  if (setupCommand != null &&
      setup != null &&
      agentDmSetupCommandApplies(setup, setupCommand)) {
    clear();
    if (context.mounted) {
      await runAgentDmSetupCommand(
        context,
        ref,
        agentPubkey,
        setup,
        setupCommand,
      );
    }
    return true;
  }
  if (builtins?.clear != null && text.trim() == '/clear') {
    newSession();
    return true;
  }
  final view = agentDmSessionViewForText(builtins, text);
  if (view == null) return false;
  clear();
  if (context.mounted) {
    await showAgentDmSessionSheet(context, agentPubkey, view);
  }
  return true;
}

/// Carries out a typed session command: a clear pick changes the session, and
/// anything else opens the panel.
Future<void> runAgentDmSetupCommand(
  BuildContext context,
  WidgetRef ref,
  String agentPubkey,
  AgentDmSessionSetup setup,
  AgentDmSetupCommand command,
) async {
  final messenger = ScaffoldMessenger.maybeOf(context);
  final speedCommand = command.name == 'speed' || command.name == 'fast';
  if (speedCommand && !setup.canChangeSpeed) {
    messenger?.showSnackBar(
      const SnackBar(content: Text("You can't change this session's speed.")),
    );
    return;
  }
  final arg = command.arg;
  final pick = command.name == 'fast'
      ? agentDmFastTogglePick(setup)
      : arg == null
      ? null
      : switch (command.name) {
          'model' => resolveAgentDmModelArg(setup, arg),
          'effort' => resolveAgentDmEffortArg(setup, arg),
          'speed' => resolveAgentDmSpeedArg(setup, arg),
          _ => null,
        };
  if (pick == null) {
    await showAgentDmSessionSheet(context, agentPubkey);
    return;
  }
  String text;
  try {
    final next = await ref.read(agentDmSessionActionsProvider).change(
      agentPubkey,
      setup,
      {speedCommand ? 'speed' : command.name: pick.id},
    );
    final shown = speedCommand
        ? next.speedLabel(pick.id ?? next.speed)
        : command.name == 'model'
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
    // The sheet closes before a view opens, so the view opens from the
    // navigator's own context.
    final navigatorContext = Navigator.of(context).context;

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
    final modes = setup.canChangeMode
        ? setup.availableModes
        : const <AgentDmSessionMode>[];
    final modeNote = setup.modeNote;
    final speeds = setup.canChangeSpeed
        ? setup.speedRows
        : const <AgentDmSpeedRow>[];
    final speedFooter = setup.speedFooter;
    return SafeArea(
      child: ListView(
        key: const ValueKey('agent-dm-session-sheet'),
        shrinkWrap: true,
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: Grid.xs),
            child: Text(setup.label, style: context.textTheme.titleSmall),
          ),
          if (setup.canChangeHarness && setup.harnesses.length > 1) ...[
            heading('Harness'),
            for (final harness in setup.harnesses)
              ListTile(
                dense: true,
                enabled: harness.available,
                selected: harness.id == setup.harness,
                title: Text(harness.label),
                trailing: harness.id == setup.harness
                    ? const Icon(BuzzIcons.check, size: 18)
                    : null,
                onTap:
                    saving.value ||
                        !harness.available ||
                        harness.id == setup.harness
                    ? null
                    : () => choose({
                        'harness': harness.id,
                        'model': null,
                        'effort': null,
                      }),
              ),
          ],
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
          if (speeds.isNotEmpty) ...[
            heading('Speed'),
            for (final speed in speeds)
              ListTile(
                dense: true,
                selected: speed.selected,
                title: Text(speed.label),
                subtitle: speed.note == null ? null : Text(speed.note!),
                trailing: speed.selected
                    ? const Icon(BuzzIcons.check, size: 18)
                    : null,
                onTap: saving.value || speed.selected || speed.note != null
                    ? null
                    : () => unawaited(
                        choose({
                          'speed': speed.id == 'standard' ? null : speed.id,
                        }),
                      ),
              ),
            if (speedFooter != null)
              Padding(
                key: const ValueKey('agent-dm-session-speed-note'),
                padding: const EdgeInsets.fromLTRB(
                  Grid.xs,
                  Grid.xxs,
                  Grid.xs,
                  0,
                ),
                child: Text(
                  speedFooter,
                  style: context.textTheme.bodySmall?.copyWith(
                    color: context.colors.onSurfaceVariant,
                  ),
                ),
              ),
          ],
          if (modes.isNotEmpty) ...[
            heading('Mode'),
            for (final mode in modes)
              choice(
                mode.label,
                mode.id == setup.mode,
                () => unawaited(choose({'mode': mode.id})),
              ),
          ],
          if (modeNote != null)
            Padding(
              key: const ValueKey('agent-dm-session-mode-note'),
              padding: const EdgeInsets.fromLTRB(Grid.xs, Grid.xxs, Grid.xs, 0),
              child: Text(
                modeNote,
                style: context.textTheme.bodySmall?.copyWith(
                  color: context.colors.onSurfaceVariant,
                ),
              ),
            ),
          if (setup.canChangeModel ||
              setup.canChangeEffort ||
              speeds.isNotEmpty ||
              modes.isNotEmpty)
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
          heading('This session'),
          for (final (label, view) in _sessionViewRows)
            ListTile(
              dense: true,
              title: Text(label),
              trailing: const Icon(Icons.chevron_right, size: 18),
              onTap: () {
                Navigator.of(context).pop();
                unawaited(
                  showAgentDmSessionViewSheet(
                    navigatorContext,
                    agentPubkey,
                    view,
                  ),
                );
              },
            ),
          const SizedBox(height: Grid.xs),
        ],
      ),
    );
  }
}
