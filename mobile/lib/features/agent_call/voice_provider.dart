import 'package:flutter/foundation.dart';

/// The caller's voice provider settings and the start response's provider
/// (Kiingo voice-provider-neutral §4, §9.1 and §9.3), read leniently. The
/// words match the desktop app and the Kiingo iPhone and Mac apps.

/// Whether this app runs Gemini's `kiingo-voice-v1` stream (the native
/// `AgentCallStream`). Off, "Call with Gemini" is shown greyed with the
/// reason, a plain tap whose choice is Gemini runs as GPT-Live and says so,
/// and the saved choices still apply on the person's other devices.
const agentCallRunsGeminiStream = true;

enum VoiceProviderId {
  gptLive('gpt-live', 'GPT-Live'),
  gemini('gemini', 'Gemini');

  const VoiceProviderId(this.wire, this.fallbackLabel);

  final String wire;
  final String fallbackLabel;

  static VoiceProviderId? read(Object? value) => switch (value) {
    'gpt-live' => VoiceProviderId.gptLive,
    'gemini' => VoiceProviderId.gemini,
    _ => null,
  };
}

/// One sentence for the person, never the code.
String voiceProviderUnavailableSentence(String? reason, String label) =>
    switch (reason) {
      'no_credential' =>
        '$label needs a Google Cloud Gemini key for your organization.',
      'model_grant_missing' => '$label isn’t enabled for your account yet.',
      'client_transport' => 'This version of the app can’t run $label calls.',
      'provider_error' => '$label is having trouble right now.',
      _ => '$label isn’t available right now.',
    };

@immutable
class VoiceProviderOption {
  const VoiceProviderOption({
    required this.id,
    required this.label,
    required this.available,
    this.unavailableReason,
  });

  final VoiceProviderId id;
  final String label;
  final bool available;
  final String? unavailableReason;
}

@immutable
class VoiceEffectiveProvider {
  const VoiceEffectiveProvider({
    required this.agentId,
    required this.provider,
    required this.revision,
    this.fallbackFrom,
    this.fallbackReason,
  });

  final String agentId;
  final VoiceProviderId provider;
  final VoiceProviderId? fallbackFrom;
  final String? fallbackReason;

  /// The agent override's own revision (0 = none set), for the agent PUT.
  final int revision;
}

@immutable
class VoiceSettings {
  const VoiceSettings({
    required this.providers,
    required this.userDefault,
    required this.agentOverrides,
    required this.revision,
    required this.effective,
  });

  /// Only the providers this app knows, in the server's order.
  final List<VoiceProviderOption> providers;
  final VoiceProviderId? userDefault;
  final Map<String, VoiceProviderId> agentOverrides;

  /// The default's revision, for the default PUT.
  final int revision;
  final VoiceEffectiveProvider? effective;

  /// The caller's own override for one agent, or null.
  VoiceProviderId? overrideFor(String agentId) {
    final wanted = agentId.toLowerCase();
    for (final entry in agentOverrides.entries) {
      if (entry.key.toLowerCase() == wanted) return entry.value;
    }
    return null;
  }

  String label(VoiceProviderId id) {
    for (final option in providers) {
      if (option.id == id) return option.label;
    }
    return id.fallbackLabel;
  }

  /// `GET …/settings` (the `{ data }` envelope or its body); null when it
  /// isn't one.
  static VoiceSettings? tryParse(Object? value) {
    final outer = value is Map ? value : null;
    final record = outer?['data'] is Map ? outer!['data'] as Map : outer;
    final rows = record?['providers'];
    if (record == null || rows is! List) return null;
    final providers = <VoiceProviderOption>[];
    for (final row in rows) {
      if (row is! Map) continue;
      final id = VoiceProviderId.read(row['id']);
      if (id == null || providers.any((known) => known.id == id)) continue;
      final available = row['available'] != false;
      providers.add(
        VoiceProviderOption(
          id: id,
          label: _string(row['label']) ?? id.fallbackLabel,
          available: available,
          unavailableReason: available
              ? null
              : _string(row['unavailableReason']),
        ),
      );
    }
    final overrides = <String, VoiceProviderId>{};
    final overrideRows = record['agentOverrides'];
    if (overrideRows is List) {
      for (final row in overrideRows) {
        if (row is! Map) continue;
        final agentId = _string(row['agentId']);
        final provider = VoiceProviderId.read(row['provider']);
        if (agentId != null && provider != null) overrides[agentId] = provider;
      }
    }
    final effective = record['effective'];
    VoiceEffectiveProvider? effectiveProvider;
    if (effective is Map) {
      final agentId = _string(effective['agentId']);
      final provider = VoiceProviderId.read(effective['provider']);
      if (agentId != null && provider != null) {
        effectiveProvider = VoiceEffectiveProvider(
          agentId: agentId,
          provider: provider,
          fallbackFrom: VoiceProviderId.read(effective['fallbackFrom']),
          fallbackReason: _string(effective['fallbackReason']),
          revision: _revision(effective['revision']),
        );
      }
    }
    return VoiceSettings(
      providers: List.unmodifiable(providers),
      userDefault: VoiceProviderId.read(record['userDefault']),
      agentOverrides: Map.unmodifiable(overrides),
      revision: _revision(record['revision']),
      effective: effectiveProvider,
    );
  }
}

/// The start response's `provider` (§9.3).
@immutable
class VoiceStartProvider {
  const VoiceStartProvider({
    required this.id,
    this.fallbackFrom,
    this.fallbackReason,
  });

  final VoiceProviderId id;
  final VoiceProviderId? fallbackFrom;
  final String? fallbackReason;

  static VoiceStartProvider? tryParse(Object? value) {
    if (value is! Map) return null;
    final id = VoiceProviderId.read(value['id']);
    if (id == null) return null;
    return VoiceStartProvider(
      id: id,
      fallbackFrom: VoiceProviderId.read(value['fallbackFrom']),
      fallbackReason: _string(value['fallbackReason']),
    );
  }
}

/// The call screen's quiet provider line: "Voice: Gemini", or "Voice:
/// GPT-Live (Gemini unavailable)" after an inherited choice fell back. Null
/// for an ordinary GPT-Live call, which says nothing.
String? voiceProviderLine(VoiceStartProvider? provider) {
  if (provider == null) return null;
  final from = provider.fallbackFrom;
  if (from != null && from != provider.id) {
    return 'Voice: ${provider.id.fallbackLabel} '
        '(${from.fallbackLabel} unavailable)';
  }
  return provider.id == VoiceProviderId.gemini
      ? 'Voice: ${provider.id.fallbackLabel}'
      : null;
}

String? _string(Object? value) =>
    value is String && value.isNotEmpty ? value : null;

int _revision(Object? value) => value is int && value >= 0 ? value : 0;
