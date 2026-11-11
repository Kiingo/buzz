import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';
import '../theme/theme.dart';
import 'agent_surface_view.dart';
import 'outside_app_cards.dart';
import 'surface_client.dart';
import 'surface_host.dart';

class OutsideAppCardsPageView extends HookConsumerWidget {
  const OutsideAppCardsPageView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final client = ref.watch(surfaceClientProvider);
    final cursors = useState<List<String?>>([null]);
    final refresh = useState(0);
    final before = cursors.value.last;
    final request = useMemoized(() => client?.outsideApps(before: before), [
      client,
      before,
      refresh.value,
    ]);
    final page = useFuture(request, preserveState: false);
    useEffect(() {
      final timer = Timer.periodic(
        const Duration(seconds: 30),
        (_) => refresh.value++,
      );
      return timer.cancel;
    }, [client, before]);
    useOnAppLifecycleStateChange((previous, state) {
      if (state == AppLifecycleState.resumed) refresh.value++;
    });
    return Scaffold(
      appBar: AppBar(
        title: const Text('Cards from outside apps'),
        actions: [
          IconButton(
            tooltip: 'Refresh cards',
            onPressed: () => refresh.value++,
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: client == null
          ? const Center(
              child: Text('Connect your Kiingo community to see your cards.'),
            )
          : page.hasError
          ? Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Text(
                    'Couldn’t load your cards. Check your Kiingo connection.',
                  ),
                  TextButton(
                    onPressed: () => refresh.value++,
                    child: const Text('Retry'),
                  ),
                ],
              ),
            )
          : page.data == null
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.all(Grid.gutter),
              children: [
                const Text(
                  'Your private Kiingo conversations. Open a card in Kiingo to answer or act.',
                ),
                if (page.data!.surfaces.isEmpty)
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: Grid.md),
                    child: Text(
                      'No cards yet. Render a card from a connected AI app.',
                    ),
                  ),
                for (final card in page.data!.surfaces)
                  _OutsideCard(
                    key: ValueKey(
                      '${client.hashCode}:${card.surfaceId}:${card.revision}',
                    ),
                    card: card,
                  ),
                Row(
                  children: [
                    if (cursors.value.length > 1)
                      TextButton(
                        onPressed: () => cursors.value = cursors.value.sublist(
                          0,
                          cursors.value.length - 1,
                        ),
                        child: const Text('Newer cards'),
                      ),
                    if (page.data!.nextBefore != null)
                      TextButton(
                        onPressed: () => cursors.value = [
                          ...cursors.value,
                          page.data!.nextBefore,
                        ],
                        child: const Text('Older cards'),
                      ),
                  ],
                ),
              ],
            ),
    );
  }
}

class _OutsideCard extends HookConsumerWidget {
  final OutsideAppCard card;
  const _OutsideCard({super.key, required this.card});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final loaded = ref
        .watch(
          agentSurfaceProvider((id: card.surfaceId, revision: card.revision)),
        )
        .value;
    return Container(
      margin: const EdgeInsets.symmetric(vertical: Grid.md),
      padding: const EdgeInsets.all(Grid.md),
      decoration: BoxDecoration(
        border: Border.all(color: context.colors.outlineVariant),
        borderRadius: BorderRadius.circular(Radii.lg),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(card.conversationTitle, style: context.textTheme.titleSmall),
          if (loaded == null)
            const Text('Card unavailable. Refresh to try again.')
          else
            AgentSurfaceView(
              loaded: loaded,
              host: SurfaceHost(
                agentName: card.appName,
                openUrl: (url) async {
                  final uri = Uri.tryParse(url);
                  if (uri == null ||
                      !{'https', 'kiingo'}.contains(uri.scheme)) {
                    return;
                  }
                  try {
                    await launchUrl(uri, mode: LaunchMode.externalApplication);
                  } catch (_) {
                    if (context.mounted) {
                      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
                        const SnackBar(
                          content: Text('Couldn’t open that link.'),
                        ),
                      );
                    }
                  }
                },
              ),
            ),
        ],
      ),
    );
  }
}
