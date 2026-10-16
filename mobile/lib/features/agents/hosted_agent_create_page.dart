import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../shared/hosted_agents/canonical_json.dart';
import '../../shared/hosted_agents/hosted_agent_catalog.dart';
import '../../shared/hosted_agents/hosted_agent_client.dart';
import '../../shared/hosted_agents/hosted_agent_controller.dart';
import '../../shared/hosted_agents/hosted_agent_deploy_request.dart';
import '../../shared/hosted_agents/hosted_agent_errors.dart';
import '../../shared/hosted_agents/hosted_agent_responses.dart';
import '../../shared/hosted_agents/provider_config_schema.dart';
import '../../shared/theme/theme.dart';
import '../../shared/widgets/app_list_card.dart';
import '../../shared/widgets/buzz_loading_indicator.dart';
import '../../shared/widgets/frosted_app_bar.dart';
import '../../shared/widgets/frosted_scaffold.dart';

part 'hosted_agent_create_page/create_form.dart';
part 'hosted_agent_create_page/execution_fields.dart';
part 'hosted_agent_create_page/failure_notice.dart';
part 'hosted_agent_create_page/preflight_status.dart';
part 'hosted_agent_create_page/where_it_runs_section.dart';

/// Starting name and instructions, matching the desktop, so the shortest path
/// is: pick a harness, press Create.
const _defaultAgentName = 'Assistant';
const _defaultAgentInstructions =
    'You are a helpful teammate. Answer clearly and briefly, say when you are '
    'unsure, and ask before doing anything that cannot be undone.';

/// Create a hosted agent: where it runs, harness and model, then name and
/// instructions. Pops with the created record's display name on success.
class HostedAgentCreatePage extends HookConsumerWidget {
  /// Creates the hosted-agent create page.
  const HostedAgentCreatePage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final catalog = ref.watch(hostedAgentCatalogProvider);
    return FrostedScaffold(
      useUtilitySurfaceTheme: true,
      appBar: const FrostedAppBar(centerTitle: true, title: Text('New agent')),
      body: catalog.when(
        loading: () => const Center(
          child: BuzzLoadingIndicator(
            size: 48,
            semanticLabel: 'Loading hosted agent options',
          ),
        ),
        error: (error, _) => _CatalogError(
          message: error is HostedAgentException
              ? error.message
              : describeHostedAgentError(''),
          onRetry: () => ref.invalidate(hostedAgentCatalogProvider),
        ),
        data: (catalog) => _CreateForm(catalog: catalog),
      ),
    );
  }
}

class _CatalogError extends StatelessWidget {
  const _CatalogError({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(Grid.gutter),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              LucideIcons.cloudOff,
              size: 36,
              color: context.colors.onSurfaceVariant,
            ),
            const SizedBox(height: Grid.xs),
            Text(
              message,
              textAlign: TextAlign.center,
              style: context.textTheme.bodyMedium?.copyWith(
                color: context.colors.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: Grid.xs),
            TextButton(onPressed: onRetry, child: const Text('Try again')),
          ],
        ),
      ),
    );
  }
}

/// Section caption used under cards.
class _Caption extends StatelessWidget {
  const _Caption(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        Grid.gutter + Grid.xxs,
        Grid.xxs,
        Grid.gutter + Grid.xxs,
        0,
      ),
      child: Text(
        text,
        style: context.textTheme.bodySmall?.copyWith(
          color: context.colors.onSurfaceVariant,
        ),
      ),
    );
  }
}

Future<void> _openExternal(String url) async {
  final uri = Uri.tryParse(url);
  if (uri == null || !isSafeHttpsUrl(url)) return;
  await launchUrl(uri, mode: LaunchMode.externalApplication);
}
