import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../shared/agent_details/agent_summary.dart';
import '../../../shared/theme/theme.dart';
import '../../../shared/widgets/app_list.dart';
import '../../../shared/widgets/app_list_card.dart';

String _harnessLabel(String harness) => switch (harness) {
  'codex' => 'Codex',
  'claude-code' => 'Claude Code',
  'antigravity' => 'Antigravity',
  _ => harness,
};

/// The "For you" line: the model this reader's turns resolve to, or why none.
String agentSummaryForYouLabel(AgentSummaryExecution execution) {
  final model = execution.resolvedModel;
  if (model != null) {
    final effort = execution.resolvedEffort;
    return effort == null ? model : '$model · $effort';
  }
  return switch (execution.unavailableReason) {
    final reason? when reason.contains('subscription') =>
      'Connect your ${_harnessLabel(execution.harness)} subscription to talk to this agent.',
    _ => "Model details aren't available for you yet.",
  };
}

/// What an agent in a 1:1 DM runs on, where, for whom, and with what: shown
/// on the DM's details page. Absent while loading and when the server has
/// nothing to show, so the page never blocks on it.
class AgentDetailsCard extends ConsumerWidget {
  const AgentDetailsCard({super.key, required this.agentPubkey});

  final String agentPubkey;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final summary = ref.watch(agentSummaryProvider(agentPubkey)).value;
    if (summary == null) return const SizedBox.shrink();
    final execution = summary.execution;
    final session = summary.session;
    final editUrl = summary.editUrl;
    return AppListCard(
      key: const ValueKey('agent-details-card'),
      label: 'Agent',
      verticalPadding: Grid.twelve,
      children: [
        if (summary.description != null)
          AppListRow(
            title: 'About',
            subtitle: summary.description,
            subtitleMaxLines: 4,
          ),
        if (execution != null)
          AppListRow(
            key: const ValueKey('agent-details-runs-on'),
            title: 'Runs on',
            subtitle:
                '${_harnessLabel(execution.harness)} · ${execution.model} · '
                '${execution.effort}${execution.pinned ? ' (pinned)' : ''}',
          ),
        if (execution != null)
          AppListRow(
            key: const ValueKey('agent-details-for-you'),
            title: 'For you',
            subtitle: agentSummaryForYouLabel(execution),
            subtitleMaxLines: 3,
          ),
        AppListRow(
          title: 'Where',
          subtitle: summary.runsOnMachine
              ? (summary.machineName ?? 'A connected machine')
              : 'Hosted compute',
        ),
        if (session != null)
          AppListRow(
            key: const ValueKey('agent-details-session'),
            title: 'Your session',
            subtitle:
                '${session.title ?? 'Current session'} · '
                '${session.turnCount} ${session.turnCount == 1 ? 'turn' : 'turns'}',
          ),
        AppListRow(
          title: 'Owner',
          subtitle:
              summary.ownerName ??
              (summary.ownerIsOrganization ? 'Your organization' : 'Unknown'),
        ),
        if (summary.skills.isNotEmpty)
          AppListRow(
            key: const ValueKey('agent-details-skills'),
            title:
                '${summary.skills.length} ${summary.skills.length == 1 ? 'skill' : 'skills'}',
            subtitle: summary.skills.join(', '),
            subtitleMaxLines: 3,
          ),
        if (summary.toolTrust != null)
          AppListRow(
            title: 'Tools',
            subtitle: summary.toolTrust == 'full'
                ? 'MCP tools, full trust'
                : 'MCP tools, standard trust',
          ),
        if (editUrl != null)
          AppListRow(
            key: const ValueKey('agent-details-edit'),
            title: 'Edit agent',
            titleColor: context.colors.primary,
            onTap: () =>
                launchUrl(editUrl, mode: LaunchMode.externalApplication),
          ),
      ],
    );
  }
}
