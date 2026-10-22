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
      final memory = HostedAutoLinkMemory();
      var current = true;
      final api = HostedAutoLinkClientApi(
        client,
        () => ref.read(hostedAgentCatalogProvider.future),
      );
      final next = HostedAutoLinkScheduler(
        isForeground: () =>
            WidgetsBinding.instance.lifecycleState == null ||
            WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed,
        runPass: () async {
          final result = await runHostedAutoLinkPass(
            api: api,
            ownerPublicKey: owner,
            memory: memory,
          );
          // A pass that finishes after the setting changed or the key
          // changed says nothing.
          if (!current || !context.mounted) return;
          if (result.sent) {
            unawaited(
              ref
                  .read(hostedAgentListProvider.notifier)
                  .refresh()
                  .catchError((Object _) {}),
            );
          }
          final note = hostedAutoLinkNote(result.linked);
          if (note != null) {
            ScaffoldMessenger.maybeOf(context)?.showSnackBar(
              SnackBar(
                content: Text(note),
                duration: const Duration(seconds: 4),
              ),
            );
          }
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
