import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../../shared/hosted_agents/hosted_agent_client.dart';
import '../../shared/hosted_agents/hosted_agent_errors.dart';
import '../../shared/hosted_agents/hosted_agent_list.dart';
import '../../shared/hosted_agents/hosted_auto_link.dart';

/// App-wide runner for "auto-link my new agents" around the signed-in
/// shell. While the owner's setting is on and hosted agents are available,
/// it runs a pass on launch, on resume and every 15 minutes in the
/// foreground, and shows a quiet "Linked: …" note when a pass linked anyone.
/// A pass in flight stops before its next signed request once the setting
/// is off or the signed-in key changes; agents refused for good are named
/// once, and passes that keep failing back off with one plain note.
class HostedAutoLinkHost extends HookConsumerWidget {
  /// Wraps [child]; renders nothing of its own.
  const HostedAutoLinkHost({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final client = ref.watch(hostedAgentClientProvider);
    final enabled = ref.watch(hostedAutoLinkSettingProvider);
    final scheduler = useRef<HostedAutoLinkScheduler?>(null);

    useEffect(() {
      if (!enabled || client == null) return null;
      final String owner;
      try {
        owner = client.ownerPublicKey();
      } on HostedAgentException {
        return null;
      }
      // Refusals and backoff are remembered for this key and mount only.
      final memory = HostedAutoLinkMemory();
      final backoff = HostedAutoLinkBackoff();
      var current = true;
      // Read live, not from this effect's snapshot: the setting or the key
      // can change while a pass is between requests.
      bool shouldContinue() {
        if (!current || !context.mounted) return false;
        if (!ref.read(hostedAutoLinkSettingProvider)) return false;
        final live = ref.read(hostedAgentClientProvider);
        if (!identical(live, client)) return false;
        try {
          return live?.ownerPublicKey().toLowerCase() == owner.toLowerCase();
        } on HostedAgentException {
          return false;
        }
      }

      void say(String text) {
        ScaffoldMessenger.maybeOf(context)?.showSnackBar(
          SnackBar(content: Text(text), duration: const Duration(seconds: 4)),
        );
      }

      final api = HostedAutoLinkClientApi(
        client,
        () => ref.read(hostedAgentCatalogProvider.future),
      );
      final next = HostedAutoLinkScheduler(
        isForeground: () =>
            WidgetsBinding.instance.lifecycleState == null ||
            WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed,
        runPass: () async {
          if (!backoff.allows(DateTime.now())) return;
          final result = await runHostedAutoLinkPass(
            api: api,
            ownerPublicKey: owner,
            memory: memory,
            shouldContinue: shouldContinue,
          );
          // A pass that finishes after the setting changed or the key
          // changed says nothing.
          if (!shouldContinue()) return;
          final failed = backoff.record(result, DateTime.now());
          if (result.sent) {
            unawaited(
              ref
                  .read(hostedAgentListProvider.notifier)
                  .refresh()
                  .catchError((Object _) {}),
            );
          }
          if (hostedAutoLinkNote(result.linked) case final note?) say(note);
          if (hostedAutoLinkRefusedNote(result.notLinked) case final note?) {
            say(note);
          }
          if (failed != null) say(failed);
        },
      );
      scheduler.value = next;
      final timer = Timer.periodic(
        hostedAutoLinkInterval,
        (_) => next.trigger(HostedAutoLinkTrigger.interval),
      );
      next.trigger(HostedAutoLinkTrigger.launch);
      return () {
        current = false;
        next.stop();
        timer.cancel();
        if (scheduler.value == next) scheduler.value = null;
      };
    }, [enabled, client]);

    useOnAppLifecycleStateChange((previous, state) {
      if (state == AppLifecycleState.resumed) {
        scheduler.value?.trigger(HostedAutoLinkTrigger.resume);
      }
    });

    return child;
  }
}
