import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:intl/intl.dart';

import '../../shared/hosted_agents/hosted_agent_client.dart';
import '../../shared/hosted_agents/hosted_agent_controller.dart';
import '../../shared/hosted_agents/hosted_agent_errors.dart';
import '../../shared/hosted_agents/hosted_agent_list.dart';
import '../../shared/hosted_agents/hosted_agent_snapshot.dart';
import '../../shared/hosted_agents/hosted_agent_store.dart';
import '../../shared/hosted_agents/owned_agents_provider.dart';
import '../../shared/theme/buzz_icons.dart';
import '../../shared/theme/theme.dart';
import '../../shared/widgets/app_list.dart';
import '../../shared/widgets/app_list_card.dart';
import '../../shared/widgets/frosted_app_bar.dart';
import '../../shared/widgets/frosted_scaffold.dart';
import '../../shared/widgets/modal_presentation.dart';
import 'hosted_agent_create_page.dart';

part 'hosted_agents_page/agent_actions.dart';
part 'hosted_agents_page/agent_detail_sheet.dart';
part 'hosted_agents_page/agent_sections.dart';

/// The owner's agents: every hosted agent with live state and full
/// management (including those created on desktop), the other agents they
/// manage, and the entry to create a hosted agent.
class HostedAgentsPage extends ConsumerWidget {
  /// Creates the agents page.
  const HostedAgentsPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final client = ref.watch(hostedAgentClientProvider);

    Future<void> openCreate() async {
      unawaited(HapticFeedback.selectionClick());
      final outcome = await Navigator.of(context).push<HostedCreateOutcome>(
        MaterialPageRoute(builder: (_) => const HostedAgentCreatePage()),
      );
      if (!context.mounted || outcome is! HostedCreateSucceeded) return;
      ref.invalidate(ownedAgentsProvider);
      unawaited(ref.read(hostedAgentListProvider.notifier).refresh());
      final record = outcome.record;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            outcome.warning ??
                '${record.displayName} is starting on ${record.destination}.',
          ),
        ),
      );
    }

    return FrostedScaffold(
      useUtilitySurfaceTheme: true,
      appBar: FrostedAppBar(
        centerTitle: true,
        title: const Text('Agents'),
        actions: [
          if (client != null)
            IconButton(
              key: const ValueKey('hosted-agents-new'),
              tooltip: 'New agent',
              icon: const Icon(BuzzIcons.plus),
              onPressed: () => unawaited(openCreate()),
            ),
        ],
      ),
      body: client == null
          ? const _AgentsUnavailable()
          : _AgentsBody(onCreate: () => unawaited(openCreate())),
    );
  }
}

class _AgentsBody extends ConsumerWidget {
  const _AgentsBody({required this.onCreate});

  final VoidCallback onCreate;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final hosted = ref.watch(hostedAgentListProvider);
    final records = ref.watch(hostedAgentStoreProvider);
    final owned = ref.watch(ownedAgentsProvider);
    final hostedKeys = {
      for (final agent in hosted.value ?? const <HostedAgentSnapshot>[])
        agent.agentPublicKey,
      for (final record in records) record.pubkey,
    };
    return RefreshIndicator(
      onRefresh: () async {
        ref.invalidate(ownedAgentsProvider);
        await ref.read(hostedAgentListProvider.notifier).refresh();
      },
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: EdgeInsets.fromLTRB(
          0,
          frostedAppBarHeight(context) + Grid.xs,
          0,
          Grid.lg,
        ),
        children: [
          _HostedSection(agents: hosted, onCreate: onCreate),
          const SizedBox(height: Grid.sm),
          _OtherAgentsSection(
            agents: owned.whenData(
              (agents) => [
                for (final agent in agents)
                  if (!hostedKeys.contains(agent.pubkey)) agent,
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _AgentsUnavailable extends StatelessWidget {
  const _AgentsUnavailable();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(Grid.gutter),
        child: Text(
          describeHostedAgentError('hosted_agents_unavailable'),
          textAlign: TextAlign.center,
          style: context.textTheme.bodyMedium?.copyWith(
            color: context.colors.onSurfaceVariant,
          ),
        ),
      ),
    );
  }
}

/// Plain label for an agent's live state.
String _stateLabel(HostedAgentSnapshot agent) {
  if (agent.isDeleted) return 'Deleting';
  if (agent.isPaused) {
    return agent.observedState == 'paused' ? 'Paused' : 'Pausing';
  }
  return switch (agent.observedState) {
    'provisioning' => 'Starting',
    'ready' => 'Running',
    'updating' => 'Updating',
    'paused' => 'Resuming',
    'action_required' => 'Needs attention',
    'degraded' => 'Degraded',
    final other =>
      other[0].toUpperCase() + other.substring(1).replaceAll('_', ' '),
  };
}
