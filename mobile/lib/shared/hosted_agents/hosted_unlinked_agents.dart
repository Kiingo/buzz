import 'package:flutter/foundation.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import 'hosted_agent_client.dart';
import 'hosted_agent_errors.dart';

/// Most agents the unlinked list may return.
const hostedUnlinkedAgentsMax = 200;

/// One of the owner's agents that has no Buzz identity yet. A new hosted
/// agent may attach to it instead of the provider creating a new agent.
@immutable
class HostedUnlinkedAgent {
  const HostedUnlinkedAgent({
    required this.kiingoAgentId,
    required this.displayName,
    required this.organizationOwned,
  });

  /// Lowercase UUID, sent back as the create's `kiingo_agent_id`.
  final String kiingoAgentId;
  final String displayName;

  /// Owned by an organization rather than by the owner personally.
  final bool organizationOwned;
}

final _uuid = RegExp(
  r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
);
final _control = RegExp(r'[\u0000-\u001f\u007f]');

/// Parse an unlinked-agents answer to [requestId]. Malformed entries,
/// repeats and machine defaults (agents kept for a computer, not for a
/// person to pick) are left out, as is anything past the first
/// [hostedUnlinkedAgentsMax]. Order is the API's (newest first).
List<HostedUnlinkedAgent> parseHostedUnlinkedAgents(
  Object? body,
  String requestId,
) {
  if (body is! Map ||
      body['contract_version'] != 1 ||
      body['correlation_id'] != requestId ||
      body['agents'] is! List) {
    throw const HostedAgentException('response_invalid');
  }
  final seen = <String>{};
  final agents = <HostedUnlinkedAgent>[];
  for (final raw in (body['agents'] as List).take(hostedUnlinkedAgentsMax)) {
    if (raw is! Map || raw['machine_default'] != false) continue;
    final id = raw['kiingo_agent_id'];
    final name = raw['display_name'];
    final principal = raw['owner_principal_type'];
    if (id is! String || name is! String) continue;
    final normalized = id.toLowerCase();
    final trimmed = name.trim();
    if (!_uuid.hasMatch(normalized) ||
        trimmed.isEmpty ||
        trimmed.runes.length > 200 ||
        _control.hasMatch(trimmed) ||
        (principal != 'User' && principal != 'Organization') ||
        !seen.add(normalized)) {
      continue;
    }
    agents.add(
      HostedUnlinkedAgent(
        kiingoAgentId: normalized,
        displayName: trimmed,
        organizationOwned: principal == 'Organization',
      ),
    );
  }
  return List.unmodifiable(agents);
}

/// The owner's unlinked agents for the create page. Empty when hosted agents
/// are unavailable; refreshed by invalidating it.
final hostedUnlinkedAgentsProvider =
    FutureProvider.autoDispose<List<HostedUnlinkedAgent>>((ref) async {
      final client = ref.watch(hostedAgentClientProvider);
      if (client == null) return const [];
      final catalog = await ref.watch(hostedAgentCatalogProvider.future);
      return client.listUnlinked(catalog: catalog);
    });
