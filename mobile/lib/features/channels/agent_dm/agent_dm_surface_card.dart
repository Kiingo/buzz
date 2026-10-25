import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../shared/agent_dm/agent_dm_markers.dart';
import '../../../shared/surfaces/agent_surface_view.dart';
import '../../../shared/surfaces/surface_client.dart';
import '../../../shared/surfaces/surface_host.dart';
import '../../../shared/surfaces/surface_sends.dart';
import '../../../shared/theme/theme.dart';
import '../../../shared/widgets/modal_presentation.dart';
import 'agent_dm_scope.dart';
import 'agent_dm_sent_provider.dart';

/// A resumed app reads the card again at most this often.
const _resumeRefresh = Duration(seconds: 15);

/// An expired image signature reads the card again at most this often.
const _mediaRefresh = Duration(minutes: 1);

/// The agent card a message points at (`buzz-surface`, §7 of
/// docs/agent-dm-markers.md), drawn under the message's own text. While it
/// loads, or when the host has no card for this person, only the text
/// shows. A newer revision on any message, or the app coming back to the
/// front, reads it again.
class AgentDmSurfaceCard extends HookConsumerWidget {
  /// The marker on the agent message.
  final AgentDmSurface surface;

  const AgentDmSurfaceCard({super.key, required this.surface});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final scope = AgentDmScope.maybeOf(context);
    final revision =
        scope?.timeline.newestSurfaceRevision(surface.surfaceId) ??
        surface.revision;
    final key = (id: surface.surfaceId, revision: revision);
    final loaded = ref.watch(agentSurfaceProvider(key)).value;
    final readAt = useRef(DateTime.now());
    final mediaReadAt = useRef<DateTime?>(null);

    void reread() {
      readAt.value = DateTime.now();
      ref.invalidate(agentSurfaceProvider(key));
    }

    useOnAppLifecycleStateChange((previous, state) {
      if (state == AppLifecycleState.resumed &&
          DateTime.now().difference(readAt.value) >= _resumeRefresh) {
        reread();
      }
    });

    if (scope == null || loaded == null) return const SizedBox.shrink();
    final channel = scope.channel;
    final personal = scope.personal;
    final messenger = ScaffoldMessenger.maybeOf(context);

    Future<void> openUrl(String url) async {
      final uri = Uri.tryParse(url);
      var opened = false;
      if (uri != null) {
        try {
          opened = await launchUrl(uri, mode: LaunchMode.externalApplication);
        } catch (error) {
          debugPrint('[AgentDm] surface link failed: ${error.runtimeType}');
        }
      }
      if (!opened) {
        messenger?.showSnackBar(
          const SnackBar(content: Text("Couldn't open that link.")),
        );
      }
    }

    // The only place a surface tap's tag is added: the composer and other
    // sends never carry it (docs/agent-dm-markers.md §7).
    Future<void> send(String text, SurfaceTap tap) async {
      try {
        await sendAgentDmMessage(
          ref,
          channel: channel,
          content: text,
          tags: [buzzSurfaceTapTag(tap)],
          personal: personal,
        );
      } catch (error) {
        debugPrint('[AgentDm] surface send failed: ${error.runtimeType}');
        messenger?.showSnackBar(
          const SnackBar(content: Text("Couldn't send. Try again.")),
        );
      }
    }

    void refreshMedia() {
      final last = mediaReadAt.value;
      if (last != null && DateTime.now().difference(last) < _mediaRefresh) {
        return;
      }
      mediaReadAt.value = DateTime.now();
      reread();
    }

    SurfaceHost hostFor({required bool expanded}) => SurfaceHost(
      openUrl: (url) => unawaited(openUrl(url)),
      sendMessage: (text, tap) => unawaited(send(text, tap)),
      refresh: refreshMedia,
      openExpanded: expanded
          ? null
          : () => unawaited(
              showBuzzModalBottomSheet<void>(
                context: context,
                title: loaded.surface.title.isEmpty
                    ? 'From ${loaded.surface.agentName ?? 'your agent'}'
                    : loaded.surface.title,
                isScrollControlled: true,
                builder: (sheetContext) => _ExpandedSurface(
                  surfaceKey: key,
                  host: hostFor(expanded: true),
                ),
              ),
            ),
    );

    return Container(
      key: const ValueKey('agent-surface-card'),
      margin: const EdgeInsets.only(top: Grid.xxs),
      constraints: const BoxConstraints(maxWidth: 560),
      padding: const EdgeInsets.all(Grid.twelve),
      decoration: BoxDecoration(
        color: context.colors.surface,
        border: Border.all(color: context.colors.outlineVariant),
        borderRadius: BorderRadius.circular(Radii.lg),
      ),
      child: AgentSurfaceView(loaded: loaded, host: hostFor(expanded: false)),
    );
  }
}

/// The card in the large sheet, following the same read as the message.
class _ExpandedSurface extends ConsumerWidget {
  final ({String id, int revision}) surfaceKey;
  final SurfaceHost host;

  const _ExpandedSurface({required this.surfaceKey, required this.host});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final loaded = ref.watch(agentSurfaceProvider(surfaceKey)).value;
    if (loaded == null) return const SizedBox.shrink();
    return SingleChildScrollView(
      padding: const EdgeInsets.all(Grid.xs),
      child: AgentSurfaceView(loaded: loaded, host: host, expanded: true),
    );
  }
}
