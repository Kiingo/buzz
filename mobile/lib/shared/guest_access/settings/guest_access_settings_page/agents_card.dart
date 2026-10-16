part of '../guest_access_settings_page.dart';

/// Each registered agent with its hosted-answer switch: on, other people are
/// answered through the hosted route; off, the agent stays owner-only and
/// other people get a short note.
class _AgentsCard extends ConsumerWidget {
  const _AgentsCard();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final agents = ref.watch(ownerGuestAgentsProvider);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        GuestOwnerListState<List<GuestOwnerAgent>>(
          value: agents,
          isEmpty: (rows) => rows.isEmpty,
          emptyText:
              'None of your agents is registered for guest access yet. An '
              'agent registers when it starts with guest access available.',
          onRetry: () => ref.invalidate(ownerGuestAgentsProvider),
          builder: (rows) => AppListCard(
            label: 'Answer other people',
            verticalPadding: Grid.twelve,
            children: [for (final agent in rows) _AgentRow(agent: agent)],
          ),
        ),
        if (agents.hasValue && agents.requireValue.isNotEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: Grid.gutter),
            child: Text(
              'Off keeps an agent owner-only: other people get a short note. '
              'Change who can ask with "Who can send instructions" in the '
              "agent's settings on desktop.",
              style: context.textTheme.bodySmall?.copyWith(
                color: context.colors.onSurfaceVariant,
              ),
            ),
          ),
      ],
    );
  }
}

class _AgentRow extends HookConsumerWidget {
  const _AgentRow({required this.agent});

  final GuestOwnerAgent agent;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final busy = useState(false);
    // The switch moves at once; the route's value replaces it on refresh.
    final optimistic = useState<bool?>(null);
    useEffect(() {
      optimistic.value = null;
      return null;
    }, [agent.enabled]);
    final name = agent.displayName ?? 'Agent';

    Future<void> toggle(bool enabled) async {
      busy.value = true;
      optimistic.value = enabled;
      final ok = await runGuestOwnerAction(
        context,
        ref,
        (client) => client.setAgentEnabled(agent.guestEndpointId, enabled),
        done: enabled
            ? '$name answers other people again.'
            : '$name is owner-only now.',
      );
      if (!context.mounted) return;
      busy.value = false;
      if (!ok) optimistic.value = null;
    }

    return AppListRow(
      key: ValueKey('guest-agent-${agent.guestEndpointId}'),
      icon: LucideIcons.bot,
      title: name,
      subtitle:
          '${respondToSummary(agent.respondTo)} Last seen '
          '${formatRelative(agent.lastSeenAt)}.',
      trailing: Switch.adaptive(
        value: optimistic.value ?? agent.enabled,
        onChanged: busy.value ? null : (value) => unawaited(toggle(value)),
      ),
    );
  }
}
