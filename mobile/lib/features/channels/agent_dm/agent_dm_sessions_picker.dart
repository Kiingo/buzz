import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../../../shared/agent_dm/agent_dm_markers.dart';
import '../../../shared/theme/buzz_icons.dart';
import '../../../shared/theme/theme.dart';
import '../../../shared/widgets/buzz_loading_indicator.dart';
import '../../../shared/widgets/modal_presentation.dart';
import '../channel.dart';
import '../channel_identity_names_provider.dart';
import '../channel_management_provider.dart';
import '../channel_messages_provider.dart';
import 'agent_dm_sent_provider.dart';
import 'agent_dm_sessions_listing_row.dart';
import 'agent_dm_timeline.dart';

part 'agent_dm_sessions_picker/dialogs.dart';
part 'agent_dm_sessions_picker/session_tile.dart';

/// A listing younger than this is reused instead of asking again.
const agentDmListingMaxAge = Duration(minutes: 2);

/// How long the picker waits for the agent to answer `/sessions`.
const agentDmListingTimeout = Duration(seconds: 15);

/// The `/sessions load` command for [sessionId].
String agentDmLoadCommand(String sessionId, {required bool catchUp}) =>
    catchUp ? '/sessions load $sessionId catchup' : '/sessions load $sessionId';

/// Whether a listing published at [createdAt] can be reused at [now], both
/// in Unix seconds.
bool agentDmListingIsFresh(int createdAt, int now) =>
    now - createdAt < agentDmListingMaxAge.inSeconds;

int _nowSeconds() => DateTime.now().millisecondsSinceEpoch ~/ 1000;

/// Opens the sessions picker for the 1:1 DM [channel] with [agentPubkey].
Future<void> showAgentDmSessionsPicker(
  BuildContext context, {
  required Channel channel,
  required String agentPubkey,
}) {
  return showBuzzModalBottomSheet<void>(
    context: context,
    title: 'Sessions',
    isScrollControlled: true,
    builder: (_) =>
        AgentDmSessionsPicker(channel: channel, agentPubkey: agentPubkey),
  );
}

/// Lists the agent's sessions and sends `/new` or `/sessions load`.
///
/// Uses the newest listing in the DM when it is under two minutes old;
/// otherwise sends `/sessions` and waits up to 15 seconds for an answer.
class AgentDmSessionsPicker extends HookConsumerWidget {
  /// The 1:1 DM with the agent.
  final Channel channel;

  /// The agent's key.
  final String agentPubkey;

  const AgentDmSessionsPicker({
    super.key,
    required this.channel,
    required this.agentPubkey,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final agent = agentPubkey.toLowerCase();
    final events = ref.watch(channelMessagesProvider(channel.id)).value;
    final members = ref.watch(channelMembersProvider(channel.id)).value;
    final currentPubkey = ref.watch(currentPubkeyProvider);
    final agentName = watchChannelIdentityLabel(ref, channel.id, agent);
    final memberKeys =
        members?.map((member) => member.pubkey).toList() ??
        channel.participantPubkeys;
    final timeline = useMemoized(
      () => AgentDmTimeline.build(
        events: events ?? const [],
        isDm: channel.isDm,
        memberPubkeys: memberKeys,
        currentPubkey: currentPubkey,
        agentPubkeys: {agent},
      ),
      [events, Object.hashAll(memberKeys), currentPubkey, agent],
    );
    final newest = timeline.newestListing(signerPubkey: agent);
    final openedAt = useMemoized(_nowSeconds);
    final generation = useState(0);
    // Listing ids present when the latest request went out; null until the
    // picker has asked.
    final knownAtRequest = useState<Set<String>?>(null);
    final timedOut = useState(false);
    final busy = useState(false);
    final error = useState<String?>(null);

    final reusable =
        generation.value == 0 &&
        newest != null &&
        agentDmListingIsFresh(newest.createdAt, openedAt);
    final known = knownAtRequest.value;
    final answered =
        known != null && newest != null && !known.contains(newest.eventId);
    final shown = reusable || answered ? newest : null;

    useEffect(() {
      if (reusable) return null;
      Timer? timeout;
      var disposed = false;
      // Outside the build that runs this effect: state writes are safe here.
      scheduleMicrotask(() async {
        if (disposed) return;
        knownAtRequest.value = timeline.listingIdsFrom(agent);
        timedOut.value = false;
        error.value = null;
        timeout = Timer(agentDmListingTimeout, () {
          if (!disposed) timedOut.value = true;
        });
        try {
          await sendAgentDmMessage(ref, channel: channel, content: '/sessions');
        } catch (sendError) {
          debugPrint('[AgentDm] /sessions failed: $sendError');
          timeout?.cancel();
          if (!disposed) {
            error.value = "Couldn't ask $agentName for sessions.";
            timedOut.value = true;
          }
        }
      });
      return () {
        disposed = true;
        timeout?.cancel();
      };
    }, [generation.value]);

    Future<void> runCommand(String content) async {
      busy.value = true;
      error.value = null;
      try {
        await sendAgentDmMessage(ref, channel: channel, content: content);
        if (context.mounted) Navigator.of(context).pop();
      } catch (sendError) {
        debugPrint('[AgentDm] session command failed: $sendError');
        if (context.mounted) error.value = "Couldn't send. Try again.";
      } finally {
        if (context.mounted) busy.value = false;
      }
    }

    Future<void> startNew() async {
      if (busy.value) return;
      if (await _confirmNewSession(context, agentName) && context.mounted) {
        await runCommand('/new');
      }
    }

    Future<void> load(AgentDmSessionItem item) async {
      if (busy.value) return;
      final catchUp = await _confirmLoadSession(context, item);
      if (catchUp == null || !context.mounted) return;
      await runCommand(agentDmLoadCommand(item.sessionId, catchUp: catchUp));
    }

    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          Grid.gutter,
          0,
          Grid.gutter,
          Grid.xs,
        ),
        child: Column(
          key: const ValueKey('agent-dm-sessions-picker'),
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Semantics(
              container: true,
              button: true,
              enabled: !busy.value,
              label: 'New session',
              hint: 'Ends the current session',
              excludeSemantics: true,
              onTap: busy.value ? null : () => unawaited(startNew()),
              child: FilledButton.tonalIcon(
                key: const ValueKey('agent-dm-sessions-new'),
                onPressed: busy.value ? null : () => unawaited(startNew()),
                icon: const Icon(BuzzIcons.plus, size: 18),
                label: const Text('New session'),
              ),
            ),
            const SizedBox(height: Grid.xs),
            if (error.value != null)
              Padding(
                padding: const EdgeInsets.only(bottom: Grid.xxs),
                child: Semantics(
                  liveRegion: true,
                  child: Text(
                    error.value!,
                    key: const ValueKey('agent-dm-sessions-error'),
                    style: context.textTheme.bodySmall?.copyWith(
                      color: context.colors.error,
                    ),
                  ),
                ),
              ),
            if (shown != null)
              _SessionList(
                listing: shown.listing,
                enabled: !busy.value,
                onLoad: (item) => unawaited(load(item)),
              )
            else if (timedOut.value)
              _TimedOut(agentName: agentName, onRetry: () => generation.value++)
            else
              Semantics(
                container: true,
                liveRegion: true,
                label: 'Asking $agentName for sessions',
                excludeSemantics: true,
                child: Padding(
                  key: const ValueKey('agent-dm-sessions-waiting'),
                  padding: const EdgeInsets.symmetric(vertical: Grid.md),
                  child: Column(
                    children: [
                      const BuzzLoadingIndicator(size: 24),
                      const SizedBox(height: Grid.xxs),
                      Text(
                        'Asking $agentName for sessions…',
                        style: context.textTheme.bodySmall,
                      ),
                    ],
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
