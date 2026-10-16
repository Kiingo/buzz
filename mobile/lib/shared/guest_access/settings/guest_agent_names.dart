import 'package:hooks_riverpod/hooks_riverpod.dart';

import 'guest_owner_providers.dart';

/// Agent display names by guest endpoint id, from the owner's agents list.
/// Empty until it loads; rows fall back to "All your agents" / "An agent".
final guestAgentNamesProvider = Provider.autoDispose<Map<String, String>>((
  ref,
) {
  final agents = ref.watch(ownerGuestAgentsProvider).value ?? const [];
  return {
    for (final agent in agents)
      agent.guestEndpointId: agent.displayName ?? 'Agent',
  };
});

/// Which agent a row applies to: its name, or every agent for `null`.
String guestAgentScopeLabel(Map<String, String> names, String? endpointId) =>
    endpointId == null ? 'All your agents' : (names[endpointId] ?? 'An agent');
