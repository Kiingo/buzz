import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../relay/relay.dart';
import 'hosted_agent_relay_publisher.dart';

/// An agent the owner manages, as published in their own kind:30177 record.
@immutable
class OwnedAgentSummary {
  const OwnedAgentSummary({required this.pubkey, required this.name});

  final String pubkey;
  final String name;
}

/// Reduce the owner's kind:30177 records and kind:5 tombstones to the agents
/// that still exist: the newest record per `d` tag, minus any coordinate a
/// tombstone at or after it deleted.
@visibleForTesting
List<OwnedAgentSummary> ownedAgentsFromEvents({
  required String ownerPubkey,
  required List<NostrEvent> records,
  required List<NostrEvent> tombstones,
}) {
  final owner = ownerPubkey.toLowerCase();
  final deletedAt = <String, int>{};
  for (final event in tombstones) {
    if (event.pubkey.toLowerCase() != owner) continue;
    for (final tag in event.tags) {
      if (tag.length < 2 || tag[0] != 'a') continue;
      final parts = tag[1].split(':');
      if (parts.length != 3 ||
          parts[0] != '$managedAgentEventKind' ||
          parts[1].toLowerCase() != owner) {
        continue;
      }
      final key = parts[2].toLowerCase();
      if ((deletedAt[key] ?? -1) < event.createdAt) {
        deletedAt[key] = event.createdAt;
      }
    }
  }
  final latest = <String, NostrEvent>{};
  for (final event in records) {
    if (event.pubkey.toLowerCase() != owner ||
        event.kind != managedAgentEventKind) {
      continue;
    }
    String? dTag;
    for (final tag in event.tags) {
      if (tag.length >= 2 && tag[0] == 'd') dTag = tag[1].toLowerCase();
    }
    if (dTag == null || !RegExp(r'^[0-9a-f]{64}$').hasMatch(dTag)) continue;
    final previous = latest[dTag];
    if (previous == null || previous.createdAt < event.createdAt) {
      latest[dTag] = event;
    }
  }
  final agents = <OwnedAgentSummary>[];
  for (final entry in latest.entries) {
    final deleted = deletedAt[entry.key];
    if (deleted != null && deleted >= entry.value.createdAt) continue;
    String? name;
    try {
      final content = jsonDecode(entry.value.content);
      if (content is Map && content['name'] is String) {
        name = (content['name'] as String).trim();
      }
    } catch (_) {
      name = null;
    }
    if (name == null || name.isEmpty) continue;
    agents.add(OwnedAgentSummary(pubkey: entry.key, name: name));
  }
  agents.sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));
  return agents;
}

/// Every agent the current owner has published a managed-agent record for,
/// including those created on desktop.
final ownedAgentsProvider = FutureProvider<List<OwnedAgentSummary>>((
  ref,
) async {
  final owner = ref.watch(myPubkeyProvider);
  final session = ref.watch(relaySessionProvider.notifier);
  if (owner == null) return const [];
  final events = await session.queryRelay([
    NostrFilter(
      kinds: const [managedAgentEventKind],
      authors: [owner],
      limit: 500,
    ),
    NostrFilter(
      kinds: const [EventKind.deletion],
      authors: [owner],
      limit: 500,
    ),
  ]);
  return ownedAgentsFromEvents(
    ownerPubkey: owner,
    records: events.where((e) => e.kind == managedAgentEventKind).toList(),
    tombstones: events.where((e) => e.kind == EventKind.deletion).toList(),
  );
});
