part of '../hosted_agents_page.dart';

/// "Auto-link my new agents" and a Link button for each agent the provider
/// holds until its owner attests it. A Link tap signs for that agent only;
/// the setting signs in the background only while it is on.
class _LinkAgentsSection extends HookConsumerWidget {
  const _LinkAgentsSection({required this.agents});

  final AsyncValue<List<HostedAgentSnapshot>> agents;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final list = agents.value;
    if (list == null) return const SizedBox.shrink();
    final pending = pendingHostedAgents(list);
    return Padding(
      padding: const EdgeInsets.only(bottom: Grid.sm),
      child: AppListCard(
        label: pending.isEmpty ? null : 'Waiting for you to link',
        verticalPadding: Grid.twelve,
        children: [
          const _AutoLinkSwitchRow(),
          for (final agent in pending)
            _LinkRow(
              key: ValueKey('hosted-link-pending-${agent.providerAgentId}'),
              agent: agent,
            ),
        ],
      ),
    );
  }
}

class _AutoLinkSwitchRow extends ConsumerWidget {
  const _AutoLinkSwitchRow();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final enabled = ref.watch(hostedAutoLinkSettingProvider);
    void toggle() => unawaited(
      ref.read(hostedAutoLinkSettingProvider.notifier).set(!enabled),
    );
    const title = 'Auto-link my new agents';
    const subtitle =
        'While Buzz is open, it signs for agents you own as they are '
        'created and re-links agents on an old key, then tells you which.';
    return Semantics(
      container: true,
      toggled: enabled,
      label: title,
      hint: subtitle,
      excludeSemantics: true,
      onTap: toggle,
      child: AppListRow(
        key: const ValueKey('hosted-auto-link'),
        icon: BuzzIcons.key,
        title: title,
        subtitle: subtitle,
        subtitleMaxLines: 3,
        trailing: Switch.adaptive(value: enabled, onChanged: (_) => toggle()),
        onTap: toggle,
      ),
    );
  }
}

/// One agent with its Link button: attest-pending for a waiting agent, or
/// re-link for one still on an earlier owner key. Each tap is one request.
class _LinkRow extends HookConsumerWidget {
  const _LinkRow({
    super.key,
    required this.agent,
    this.rebind = false,
    this.onOpen,
  });

  final HostedAgentSnapshot agent;

  /// Opens the agent (live agents only); the Link button stays its own stop.
  final VoidCallback? onOpen;

  /// Re-link to the current key instead of attesting a pending agent.
  final bool rebind;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final busy = useState(false);
    final label = useState<String?>(null);
    final failed = useState(false);
    final done = useState(false);

    Future<void> link() async {
      if (busy.value || done.value) return;
      unawaited(HapticFeedback.selectionClick());
      busy.value = true;
      final list = ref.read(hostedAgentListProvider.notifier);
      try {
        if (rebind) {
          final [outcome] = await list.rebindOwnerKey([agent]);
          if (!context.mounted) return;
          final ok = outcome.status != HostedRebindStatus.rejected;
          failed.value = !ok;
          done.value = ok || !outcome.retryable;
          label.value = outcome.label;
        } else {
          final [outcome] = await list.attestPending([agent]);
          if (!context.mounted) return;
          failed.value = !outcome.linked;
          done.value = outcome.linked || !outcome.retryable;
          label.value = outcome.label;
        }
      } on HostedAgentException catch (error) {
        if (!context.mounted) return;
        failed.value = true;
        label.value = rebind
            ? describeRebindRequestError(error)
            : describeAttestRequestError(error);
      } catch (_) {
        if (!context.mounted) return;
        failed.value = true;
        label.value = describeHostedAgentError('');
      } finally {
        if (context.mounted) busy.value = false;
      }
    }

    final String action = busy.value
        ? 'Linking…'
        : (failed.value ? 'Retry' : 'Link');
    final Widget trailing;
    if (done.value) {
      trailing = Icon(
        failed.value ? BuzzIcons.circleAlert : BuzzIcons.circleCheck,
        size: 22,
        color: failed.value
            ? context.colors.error
            : context.colors.onSurfaceVariant,
      );
    } else {
      trailing = Semantics(
        button: true,
        enabled: !busy.value,
        label: '$action ${agent.displayName}',
        excludeSemantics: true,
        onTap: busy.value ? null : () => unawaited(link()),
        child: TextButton(
          key: ValueKey('hosted-link-${agent.providerAgentId}'),
          onPressed: busy.value ? null : () => unawaited(link()),
          child: Text(action),
        ),
      );
    }
    return AppListRow(
      icon: rebind ? BuzzIcons.key : BuzzIcons.bot,
      title: agent.displayName,
      subtitle:
          label.value ??
          (rebind
              ? 'Still linked to your old key.'
              : 'Ready to join Buzz once you link it.'),
      subtitleMaxLines: 2,
      subtitleStyle: failed.value
          ? context.textTheme.bodySmall?.copyWith(color: context.colors.error)
          : null,
      trailing: trailing,
      onTap: onOpen,
    );
  }
}
