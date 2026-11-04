import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../shared/agent_dm/agent_dm_session_setup.dart';
import '../../../shared/agent_dm/agent_dm_turn_steps.dart';
import '../../../shared/theme/theme.dart';

/// The quiet line under the hosted agent's reply in the reader's own 1:1 DM
/// ("Used 6 tools · 41 s", else "Steps"). It opens in place to the turn's
/// steps, read only. Every step's words are the agent's or a tool's:
/// untrusted, shown as plain text.
class AgentDmTurnStepsRow extends HookConsumerWidget {
  const AgentDmTurnStepsRow({
    super.key,
    required this.agentPubkey,
    required this.replyKey,
  });

  /// The DM's agent, the reply's signer.
  final String agentPubkey;

  /// The reply's Run or mirrored entry.
  final AgentDmReplyKey replyKey;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final agent = agentPubkey.toLowerCase();
    final open = useState(false);
    final askedAgain = useRef(false);
    // Only an agent with a host: the panel read says so, and the host
    // answers the reader's own conversation alone.
    final hosted =
        ref.watch(agentDmSessionSetupProvider(agent)).asData?.value != null;
    final page = hosted
        ? ref.watch(agentDmTurnPageProvider(agent)).asData?.value
        : null;
    final reply = page == null
        ? null
        : findAgentDmReply(page.replies, replyKey);
    final landedSince =
        page != null && reply == null && replyKey.atMs > page.readAtMs;
    // A reply that landed after the page read asks once more.
    useEffect(() {
      if (landedSince && !askedAgain.value) {
        askedAgain.value = true;
        scheduleMicrotask(() => ref.invalidate(agentDmTurnPageProvider(agent)));
      }
      return null;
    }, [landedSince]);
    if (reply == null) return const SizedBox.shrink();

    final muted = context.colors.onSurfaceVariant;
    final style = context.textTheme.labelSmall?.copyWith(color: muted);
    final stepsKey = (agentPubkey: agent, turnId: reply.turnId);
    return Padding(
      padding: const EdgeInsets.only(top: Grid.quarter),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          TextButton(
            key: const ValueKey('agent-dm-turn-steps-line'),
            style: TextButton.styleFrom(
              padding: const EdgeInsets.symmetric(vertical: Grid.quarter),
              minimumSize: Size.zero,
              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
              foregroundColor: muted,
            ),
            onPressed: () => open.value = !open.value,
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Flexible(
                  child: Text(
                    reply.line,
                    style: style,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                const SizedBox(width: Grid.quarter),
                Icon(
                  open.value
                      ? Icons.keyboard_arrow_up
                      : Icons.keyboard_arrow_down,
                  size: 14,
                  color: muted,
                ),
              ],
            ),
          ),
          if (open.value) _StepsPanel(stepsKey: stepsKey, style: style),
        ],
      ),
    );
  }
}

class _StepsPanel extends ConsumerWidget {
  const _StepsPanel({required this.stepsKey, required this.style});

  final ({String agentPubkey, String turnId}) stepsKey;
  final TextStyle? style;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final read = ref.watch(agentDmTurnStepsProvider(stepsKey));
    final steps = read.asData?.value;
    return Container(
      key: const ValueKey('agent-dm-turn-steps'),
      padding: const EdgeInsets.only(left: Grid.xxs),
      decoration: BoxDecoration(
        border: Border(left: BorderSide(color: context.colors.outlineVariant)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          if (read.hasError && steps == null)
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Flexible(child: Text(agentDmStepsReadFailed, style: style)),
                TextButton(
                  onPressed: () =>
                      ref.invalidate(agentDmTurnStepsProvider(stepsKey)),
                  child: const Text('Try again'),
                ),
              ],
            )
          else if (steps == null)
            Text('Loading steps…', style: style)
          else ...[
            if (steps.omitted > 0)
              Text(
                steps.omitted == 1
                    ? '1 earlier step not shown'
                    : '${steps.omitted} earlier steps not shown',
                style: style,
              ),
            if (steps.items.isEmpty)
              Text('No steps for this reply.', style: style)
            else
              for (final step in steps.items)
                _StepRow(key: ValueKey(step.id), step: step, style: style),
            if (steps.durationMs != null && !steps.running)
              Text(
                'Took ${agentDmStepsDuration(steps.durationMs!)}',
                style: style,
              ),
          ],
        ],
      ),
    );
  }
}

class _StepRow extends HookWidget {
  const _StepRow({super.key, required this.step, required this.style});

  final AgentDmTurnStep step;
  final TextStyle? style;

  @override
  Widget build(BuildContext context) {
    final open = useState(false);
    final label = step.action == null
        ? step.line
        : '${step.action} · ${step.line}';
    final state = switch (step.state) {
      AgentDmStepState.running => 'Running',
      AgentDmStepState.failed => 'Failed',
      AgentDmStepState.done => 'Done',
    };
    final stateStyle = step.state == AgentDmStepState.failed
        ? style?.copyWith(color: context.colors.error)
        : style;
    final line = Text(
      '$state · $label',
      style: stateStyle,
      maxLines: open.value ? null : 1,
      overflow: open.value ? null : TextOverflow.ellipsis,
    );
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: Grid.quarter),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          if (step.hasDetail)
            InkWell(onTap: () => open.value = !open.value, child: line)
          else
            line,
          if (step.linkUrl != null)
            TextButton(
              style: TextButton.styleFrom(
                padding: EdgeInsets.zero,
                minimumSize: Size.zero,
                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
              ),
              onPressed: () => unawaited(
                launchUrl(step.linkUrl!, mode: LaunchMode.externalApplication),
              ),
              child: Text(step.linkTitle ?? 'Open', style: style),
            ),
          if (open.value)
            for (final (name, value) in [
              ('Note', step.text),
              ('Input', step.args),
              ('Result', step.result),
            ])
              if (value != null)
                Padding(
                  padding: const EdgeInsets.only(top: Grid.quarter),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(name, style: style),
                      Container(
                        width: double.infinity,
                        padding: const EdgeInsets.all(Grid.half),
                        decoration: BoxDecoration(
                          color: context.controlSurface,
                          borderRadius: BorderRadius.circular(Radii.sm),
                        ),
                        child: SelectableText(
                          value,
                          style: style?.copyWith(fontFamily: 'monospace'),
                        ),
                      ),
                    ],
                  ),
                ),
        ],
      ),
    );
  }
}
