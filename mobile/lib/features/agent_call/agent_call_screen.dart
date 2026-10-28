import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../shared/theme/buzz_icons.dart';
import '../../shared/theme/theme.dart';
import '../../shared/widgets/ios_navigation_bar.dart';
import 'agent_call_api.dart';
import 'agent_call_chooser.dart';
import 'agent_call_controller.dart';
import 'agent_call_feed.dart';
import 'voice_provider.dart';

/// Starts (or returns to) the call with the agent of a 1:1 DM and shows the
/// call screen. The host checks that this is the caller's own private DM
/// with the agent before it answers. [provider] is a chooser pick; a plain
/// tap leaves the voice to the host.
Future<void> openAgentCall(
  BuildContext context,
  WidgetRef ref, {
  required String agentPubkey,
  required String channelId,
  required String agentName,
  VoiceProviderId? provider,
}) async {
  final call = ref.read(agentCallProvider);
  final notifier = ref.read(agentCallProvider.notifier);
  if (!call.isBusy) {
    if (call.phase == AgentCallPhase.ended ||
        call.phase == AgentCallPhase.error) {
      notifier.dismiss();
    }
    unawaited(
      notifier.start(
        agentPubkey: agentPubkey,
        channelId: channelId,
        agentName: agentName,
        provider: provider,
        expectedProvider: ref
            .read(agentVoiceSettingsProvider(agentPubkey))
            .value
            ?.effective
            ?.provider,
      ),
    );
  }
  await Navigator.of(context).push<void>(
    MaterialPageRoute<void>(
      fullscreenDialog: true,
      builder: (_) => const AgentCallScreen(),
    ),
  );
}

/// The native bar's Call item: a tap calls, a long press opens the voice
/// chooser when the host offers more than one voice.
IosNavigationAction agentCallNavigationAction(
  BuildContext context,
  WidgetRef ref, {
  required String agentPubkey,
  required String channelId,
  required String agentName,
}) {
  final busy = ref.watch(agentCallProvider.select((call) => call.isBusy));
  final settings = agentVoiceChoices(ref, agentPubkey);
  return IosNavigationAction(
    label: 'Call $agentName',
    symbol: 'phone',
    menuOnLongPress: true,
    onPressed: () => unawaited(
      openAgentCall(
        context,
        ref,
        agentPubkey: agentPubkey,
        channelId: channelId,
        agentName: agentName,
      ),
    ),
    children: settings == null || busy
        ? const []
        : agentCallChooserActions(
            context,
            ref,
            settings: settings,
            agentPubkey: agentPubkey,
            channelId: channelId,
            agentName: agentName,
          ),
  );
}

/// The "Call" button in a 1:1 agent DM header. Calls run on iOS only (the
/// native media is iOS), so elsewhere there is no button.
class AgentCallButton extends ConsumerWidget {
  const AgentCallButton({
    super.key,
    required this.agentPubkey,
    required this.channelId,
    required this.agentName,
  });

  final String agentPubkey;
  final String channelId;
  final String agentName;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (defaultTargetPlatform != TargetPlatform.iOS) {
      return const SizedBox.shrink();
    }
    final call = ref.watch(agentCallProvider);
    final onThisCall = call.isBusy && call.agentPubkey == agentPubkey;
    final label = onThisCall ? 'Back to the call' : 'Call $agentName';
    final chooser = !call.isBusy && agentVoiceChoices(ref, agentPubkey) != null;
    final button = IconButton(
      key: const ValueKey('agent-call-button'),
      color: onThisCall ? context.appColors.success : context.colors.primary,
      tooltip: label,
      onPressed: () => unawaited(
        openAgentCall(
          context,
          ref,
          agentPubkey: agentPubkey,
          channelId: channelId,
          agentName: agentName,
        ),
      ),
      icon: Icon(Icons.call_outlined, size: 22, semanticLabel: label),
    );
    if (!chooser) return button;
    return Semantics(
      onLongPressHint: 'Choose the voice',
      child: GestureDetector(
        key: const ValueKey('agent-call-chooser'),
        onLongPress: () => unawaited(
          showAgentCallChooser(
            context,
            ref,
            agentPubkey: agentPubkey,
            channelId: channelId,
            agentName: agentName,
          ),
        ),
        child: button,
      ),
    );
  }
}

String _statusLine(AgentCallState call, int seconds) => switch (call.phase) {
  AgentCallPhase.connecting => 'Calling…',
  AgentCallPhase.live =>
    '${seconds ~/ 60}:${(seconds % 60).toString().padLeft(2, '0')}',
  AgentCallPhase.ending => 'Hanging up…',
  AgentCallPhase.ended => switch (call.endReason) {
    'time_limit' => 'Call ended (time limit)',
    'connection_lost' || 'media_failed' => 'Call ended (connection lost)',
    _ => 'Call ended',
  },
  AgentCallPhase.error => "Couldn't call",
  AgentCallPhase.idle => '',
};

/// The call screen: who, how long, mute, hang up, stop the agent's work,
/// the call's asks with the open question's options, and after hang-up the
/// recap. Closing the screen during a call keeps the call going.
class AgentCallScreen extends HookConsumerWidget {
  const AgentCallScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final call = ref.watch(agentCallProvider);
    final notifier = ref.read(agentCallProvider.notifier);
    final tick = useState(0);
    useEffect(() {
      if (call.phase != AgentCallPhase.live) return null;
      final timer = Timer.periodic(
        const Duration(seconds: 1),
        (_) => tick.value++,
      );
      return timer.cancel;
    }, [call.phase]);
    useEffect(() {
      if (call.phase == AgentCallPhase.idle) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (context.mounted) Navigator.of(context).maybePop();
        });
      }
      return null;
    }, [call.phase]);
    final seconds = call.connectedAt == null
        ? 0
        : DateTime.now().difference(call.connectedAt!).inSeconds;
    final feed = call.feed;
    final live = call.phase == AgentCallPhase.live;
    final busy = call.isBusy;

    return Scaffold(
      appBar: AppBar(
        leading: IconButton(
          tooltip: busy ? 'Minimize' : 'Close',
          icon: Icon(busy ? Icons.expand_more : Icons.close),
          onPressed: () {
            if (!busy) notifier.dismiss();
            Navigator.of(context).maybePop();
          },
        ),
        title: Column(
          children: [
            Text(call.agentName ?? 'Agent'),
            Semantics(
              liveRegion: true,
              child: Text(
                _statusLine(call, seconds),
                style: context.textTheme.bodySmall?.copyWith(
                  color: context.colors.onSurfaceVariant,
                ),
              ),
            ),
            if (voiceProviderLine(call.voice) case final line?)
              Text(
                line,
                key: const ValueKey('agent-call-voice'),
                style: context.textTheme.bodySmall?.copyWith(
                  color: context.colors.onSurfaceVariant,
                ),
              ),
          ],
        ),
        centerTitle: true,
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(Grid.gutter),
          children: [
            if (call.phase == AgentCallPhase.error) ...[
              Text(call.error ?? "The call couldn't start."),
              if (call.offersGptLive)
                Padding(
                  padding: const EdgeInsets.only(top: Grid.twelve),
                  child: FilledButton.tonalIcon(
                    key: const ValueKey('agent-call-gpt-live'),
                    onPressed: () => unawaited(notifier.retryWithGptLive()),
                    icon: const Icon(Icons.call_outlined),
                    label: const Text('Call with GPT-Live'),
                  ),
                ),
            ] else ...[
              if (busy && call.systemCallUI == 'in_app') const _InAppBanner(),
              if (feed?.openQuestion case final question?)
                _QuestionCard(question: question),
              if (feed != null)
                for (final ask in feed.shownAsks)
                  _AskTile(ask: ask, live: live, v2: feed.isV2),
              if ((feed?.shownAsks.isEmpty ?? true) && live)
                Text(
                  'Talk to ${call.agentName ?? 'the agent'}. What you ask shows up here.',
                  style: context.textTheme.bodyMedium?.copyWith(
                    color: context.colors.onSurfaceVariant,
                  ),
                ),
              if ((feed?.archivedCount ?? 0) > 0)
                Padding(
                  padding: const EdgeInsets.only(top: Grid.xxs),
                  child: Text('Archived (${feed!.archivedCount})'),
                ),
              if (call.phase == AgentCallPhase.ended && feed != null)
                _Recap(feed: feed),
              if (feed?.destinationLabel case final label?)
                Padding(
                  padding: const EdgeInsets.only(top: Grid.xs),
                  child: Text(
                    'Answers go to $label.',
                    style: context.textTheme.bodySmall?.copyWith(
                      color: context.colors.onSurfaceVariant,
                    ),
                  ),
                ),
            ],
          ],
        ),
      ),
      bottomNavigationBar: busy
          ? SafeArea(
              child: Padding(
                padding: const EdgeInsets.all(Grid.xs),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                  children: [
                    IconButton.filledTonal(
                      tooltip: call.muted ? 'Unmute' : 'Mute',
                      isSelected: call.muted,
                      onPressed: live ? notifier.toggleMute : null,
                      icon: Icon(call.muted ? BuzzIcons.micOff : BuzzIcons.mic),
                    ),
                    if (live && (feed?.anyWorking ?? false))
                      _StopButton(status: call.stop),
                    IconButton.filled(
                      tooltip: 'Hang up (the agent keeps working)',
                      style: IconButton.styleFrom(
                        backgroundColor: context.colors.error,
                        foregroundColor: context.colors.onError,
                      ),
                      onPressed: () => unawaited(notifier.hangUp()),
                      icon: const Icon(BuzzIcons.phoneOff),
                    ),
                  ],
                ),
              ),
            )
          : null,
    );
  }
}

class _StopButton extends ConsumerWidget {
  const _StopButton({required this.status});

  final AgentCallStopStatus status;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final label = switch (status) {
      AgentCallStopStatus.stopping => 'Stopping…',
      AgentCallStopStatus.stopped => 'Stopped',
      AgentCallStopStatus.nothingToStop => 'Nothing to stop',
      AgentCallStopStatus.failed => "Couldn't stop",
      AgentCallStopStatus.idle => 'Stop the agent',
    };
    return TextButton.icon(
      onPressed: status == AgentCallStopStatus.stopping
          ? null
          : () =>
                unawaited(ref.read(agentCallProvider.notifier).stopAgentWork()),
      icon: const Icon(Icons.stop_circle_outlined),
      label: Text(label),
    );
  }
}

Future<void> _run(BuildContext context, Future<void> Function() action) async {
  try {
    await action();
  } catch (error) {
    if (!context.mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(describeAgentCallError(error))));
  }
}

class _QuestionCard extends HookConsumerWidget {
  const _QuestionCard({required this.question});

  final AgentCallHumanAsk question;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final sending = useState(false);
    final notifier = ref.read(agentCallProvider.notifier);
    return Card(
      margin: const EdgeInsets.only(bottom: Grid.twelve),
      child: Padding(
        padding: const EdgeInsets.all(Grid.twelve),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (final item in question.questions) ...[
              Text(item.question, style: context.textTheme.bodyLarge),
              const SizedBox(height: Grid.xxs),
              Wrap(
                spacing: Grid.xxs,
                runSpacing: Grid.half,
                children: [
                  for (final (index, label) in item.options)
                    FilledButton.tonal(
                      onPressed: sending.value
                          ? null
                          : () async {
                              sending.value = true;
                              await _run(
                                context,
                                () => notifier.answerQuestion(
                                  humanAskId: question.humanAskId,
                                  questionId: item.id,
                                  optionIndex: index,
                                ),
                              );
                              if (context.mounted) sending.value = false;
                            },
                      child: Text(label),
                    ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _AskTile extends ConsumerWidget {
  const _AskTile({required this.ask, required this.live, required this.v2});

  final AgentCallAsk ask;
  final bool live;

  /// Per-ask controls (cancel, archive) are feed v2 routes.
  final bool v2;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final notifier = ref.read(agentCallProvider.notifier);
    final liveLine = ask.liveLine;
    final canCancel =
        v2 &&
        live &&
        ask.cancelledAt == null &&
        (ask.canCancel ?? !ask.isTerminal);
    final result = ask.resultText?.trim() ?? '';
    return Card(
      margin: const EdgeInsets.only(bottom: Grid.xxs),
      child: Padding(
        padding: const EdgeInsets.all(Grid.twelve),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    ask.displayTitle,
                    style: context.textTheme.titleSmall,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                if (canCancel)
                  IconButton(
                    tooltip: 'Cancel this ask',
                    icon: const Icon(Icons.close, size: 20),
                    onPressed: () =>
                        _run(context, () => notifier.cancelAsk(ask.askKey)),
                  ),
                if (v2)
                  IconButton(
                    tooltip: 'Archive (the work goes on)',
                    icon: const Icon(Icons.archive_outlined, size: 20),
                    onPressed: () =>
                        _run(context, () => notifier.archiveAsk(ask.askKey)),
                  ),
              ],
            ),
            Text(
              liveLine == null
                  ? ask.statusLabel
                  : '${ask.statusLabel} · $liveLine',
              style: context.textTheme.bodySmall?.copyWith(
                color: context.colors.onSurfaceVariant,
              ),
            ),
            if (result.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: Grid.half),
                child: Text(
                  result,
                  maxLines: 6,
                  overflow: TextOverflow.ellipsis,
                ),
              )
            else if (ask.statusReason case final reason?)
              if (ask.status == 'not_answered' || ask.status == 'failed')
                Padding(
                  padding: const EdgeInsets.only(top: Grid.half),
                  child: Text(reason),
                ),
            _Links(links: ask.links),
          ],
        ),
      ),
    );
  }
}

class _Recap extends StatelessWidget {
  const _Recap({required this.feed});

  final AgentCallFeed feed;

  @override
  Widget build(BuildContext context) {
    if (!feed.isV2) return const SizedBox.shrink();
    final summary = feed.recapSummary;
    return Padding(
      padding: const EdgeInsets.only(top: Grid.xs),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Recap', style: context.textTheme.titleSmall),
          const SizedBox(height: Grid.half),
          Text(summary ?? 'Writing the recap…'),
          _Links(links: feed.recapLinks),
        ],
      ),
    );
  }
}

/// CallKit refused this call, so it runs without the system call screen.
class _InAppBanner extends StatelessWidget {
  const _InAppBanner();

  @override
  Widget build(BuildContext context) {
    return Container(
      key: const ValueKey('agent-call-in-app-banner'),
      margin: const EdgeInsets.only(bottom: Grid.xs),
      padding: const EdgeInsets.all(Grid.xs),
      decoration: BoxDecoration(
        color: context.colors.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(Radii.md),
      ),
      child: Text(
        "This call isn't on the iPhone's call screen. Mute and hang up here, "
        'and keep Buzz open.',
        style: context.textTheme.bodySmall,
      ),
    );
  }
}

/// The link's host, shown beside its label so a label can't disguise it.
String _linkHost(String url) => Uri.tryParse(url)?.host ?? '';

class _Links extends StatelessWidget {
  const _Links({required this.links});

  final List<AgentCallLink> links;

  @override
  Widget build(BuildContext context) {
    if (links.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final link in links.take(10))
          TextButton(
            onPressed: () {
              final uri = Uri.tryParse(link.url);
              if (uri != null) {
                unawaited(launchUrl(uri, mode: LaunchMode.externalApplication));
              }
            },
            child: Text(
              '${link.label} (${_linkHost(link.url)})',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
      ],
    );
  }
}
