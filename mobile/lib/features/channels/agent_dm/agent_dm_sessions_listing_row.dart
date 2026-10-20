import 'package:flutter/material.dart';

import '../../../shared/agent_dm/agent_dm_markers.dart';
import '../../../shared/theme/theme.dart';
import '../date_formatters.dart';

/// One line describing a session: current marker, turns and last activity.
String agentDmSessionSummary(AgentDmSessionItem item) => [
  if (item.isCurrent) 'Current',
  '${item.turnCount} ${item.turnCount == 1 ? 'turn' : 'turns'}',
  'active ${relativeTime(item.lastActiveAt)}',
  if (!item.loadable) "can't be loaded",
].join(' · ');

/// The title shown for a session.
String agentDmSessionTitle(AgentDmSessionItem item) =>
    item.title.trim().isEmpty ? 'Untitled session' : item.title.trim();

/// A compact, read-only list of the agent's sessions. The picker in the DM
/// header is where sessions are loaded.
class AgentDmSessionsListingRow extends StatelessWidget {
  /// The listing.
  final AgentDmSessionsListing listing;

  /// The event's numbered text, shown when the listing has no items.
  final String fallbackText;

  const AgentDmSessionsListingRow({
    super.key,
    required this.listing,
    required this.fallbackText,
  });

  @override
  Widget build(BuildContext context) {
    final muted = context.colors.onSurfaceVariant;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: Grid.half),
      child: DecoratedBox(
        decoration: BoxDecoration(
          border: Border.all(color: context.colors.outlineVariant),
          borderRadius: BorderRadius.circular(Radii.lg),
        ),
        child: Padding(
          padding: const EdgeInsets.all(Grid.twelve),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Semantics(
                header: true,
                child: Text(
                  'Sessions',
                  style: context.textTheme.labelMedium?.copyWith(
                    color: muted,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              if (listing.items.isEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: Grid.half),
                  child: Text(
                    fallbackText.trim().isEmpty
                        ? 'No sessions yet.'
                        : fallbackText.trim(),
                    style: context.textTheme.bodySmall,
                  ),
                ),
              for (final item in listing.items)
                Semantics(
                  container: true,
                  label:
                      '${agentDmSessionTitle(item)}. ${agentDmSessionSummary(item)}',
                  excludeSemantics: true,
                  child: Padding(
                    padding: const EdgeInsets.only(top: Grid.half),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          agentDmSessionTitle(item),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: context.textTheme.bodyMedium?.copyWith(
                            fontWeight: item.isCurrent
                                ? FontWeight.w600
                                : FontWeight.normal,
                          ),
                        ),
                        Text(
                          agentDmSessionSummary(item),
                          style: context.textTheme.bodySmall?.copyWith(
                            color: muted,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
