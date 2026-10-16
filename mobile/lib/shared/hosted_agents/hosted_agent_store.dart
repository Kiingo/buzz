import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../relay/relay.dart';
import '../theme/theme_provider.dart';
import 'hosted_agent_config.dart';

/// A hosted agent this phone created. Only public data is kept: the agent's
/// public key, the API's agent id and what the owner chose. The agent's
/// private key is never stored on the phone.
@immutable
class HostedAgentRecord {
  const HostedAgentRecord({
    required this.pubkey,
    required this.providerAgentId,
    required this.displayName,
    required this.destination,
    required this.createdAt,
    this.harness,
    this.model,
    this.observedState,
  });

  final String pubkey;

  /// The API's id, used for confirmed delete.
  final String providerAgentId;
  final String displayName;

  /// Where it runs, e.g. the destination name from the catalog.
  final String destination;
  final String? harness;
  final String? model;

  /// The state the API reported when the agent was created.
  final String? observedState;
  final DateTime createdAt;

  Map<String, Object?> toJson() => {
    'pubkey': pubkey,
    'provider_agent_id': providerAgentId,
    'display_name': displayName,
    'destination': destination,
    'harness': harness,
    'model': model,
    'observed_state': observedState,
    'created_at': createdAt.toUtc().toIso8601String(),
  };

  static HostedAgentRecord? fromJson(Object? value) {
    if (value is! Map) return null;
    final pubkey = value['pubkey'];
    final id = value['provider_agent_id'];
    final name = value['display_name'];
    if (pubkey is! String || id is! String || name is! String) return null;
    String? optional(String key) =>
        value[key] is String ? value[key] as String : null;
    return HostedAgentRecord(
      pubkey: pubkey,
      providerAgentId: id,
      displayName: name,
      destination: optional('destination') ?? '',
      harness: optional('harness'),
      model: optional('model'),
      observedState: optional('observed_state'),
      createdAt:
          DateTime.tryParse(optional('created_at') ?? '') ??
          DateTime.fromMillisecondsSinceEpoch(0),
    );
  }
}

/// Decode a stored list, skipping malformed entries.
@visibleForTesting
List<HostedAgentRecord> decodeHostedAgentRecords(String? raw) {
  if (raw == null || raw.isEmpty) return const [];
  try {
    final decoded = jsonDecode(raw);
    if (decoded is! List) return const [];
    return decoded
        .map(HostedAgentRecord.fromJson)
        .whereType<HostedAgentRecord>()
        .toList(growable: false);
  } catch (_) {
    return const [];
  }
}

/// Phone-created hosted agents for the active community and identity.
class HostedAgentStore extends Notifier<List<HostedAgentRecord>> {
  String? _key;
  late SharedPreferences _prefs;

  @override
  List<HostedAgentRecord> build() {
    _prefs = ref.watch(savedPrefsProvider);
    final route = ref.watch(hostedAgentRouteProvider);
    final owner = ref.watch(myPubkeyProvider);
    if (route == null || owner == null) {
      _key = null;
      return const [];
    }
    _key = 'hosted_agents.v1:${route.communityId}:$owner';
    return decodeHostedAgentRecords(_prefs.getString(_key!));
  }

  Future<void> _save(List<HostedAgentRecord> next) async {
    state = List.unmodifiable(next);
    final key = _key;
    if (key == null) return;
    await _prefs.setString(
      key,
      jsonEncode(next.map((record) => record.toJson()).toList()),
    );
  }

  /// Add or replace the record for [record.pubkey].
  Future<void> upsert(HostedAgentRecord record) => _save([
    for (final existing in state)
      if (existing.pubkey != record.pubkey) existing,
    record,
  ]);

  /// Forget the record for [pubkey].
  Future<void> remove(String pubkey) => _save([
    for (final existing in state)
      if (existing.pubkey != pubkey) existing,
  ]);
}

final hostedAgentStoreProvider =
    NotifierProvider<HostedAgentStore, List<HostedAgentRecord>>(
      HostedAgentStore.new,
    );
