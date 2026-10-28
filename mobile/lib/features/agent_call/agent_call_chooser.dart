import 'dart:async';

import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../../shared/theme/theme.dart';
import '../../shared/widgets/ios_navigation_bar.dart';
import '../../shared/widgets/modal_presentation.dart';
import 'agent_call_api.dart';
import 'agent_call_controller.dart';
import 'agent_call_screen.dart';
import 'voice_provider.dart';

/// The caller's voice settings for one agent (§9.1), kept 60 s like the
/// host's availability read. Null while loading, on a failed read, or from a
/// host without the route (then there's no chooser).
final agentVoiceSettingsProvider = FutureProvider.autoDispose
    .family<VoiceSettings?, String>((ref, agentPubkey) async {
      final api = ref.watch(agentCallApiProvider);
      if (api == null) return null;
      final link = ref.keepAlive();
      final timer = Timer(const Duration(seconds: 60), link.close);
      ref.onDispose(timer.cancel);
      try {
        return await api.voiceSettings(agentPubkey);
      } on AgentCallApiException {
        link.close();
        return null;
      }
    });

/// The voice settings read for [agentPubkey] when it has a choice to make
/// (more than one provider), else null.
VoiceSettings? agentVoiceChoices(WidgetRef ref, String agentPubkey) {
  final settings = ref.watch(agentVoiceSettingsProvider(agentPubkey)).value;
  return settings != null && settings.providers.length > 1 ? settings : null;
}

/// The reason "Call with <option>" can't run from this phone, or null.
String? _callUnavailable(VoiceProviderOption option) {
  if (option.id == VoiceProviderId.gemini && !agentCallRunsGeminiStream) {
    return voiceProviderUnavailableSentence('client_transport', option.label);
  }
  return option.available
      ? null
      : voiceProviderUnavailableSentence(
          option.unavailableReason,
          option.label,
        );
}

enum _ChoiceKind { call, always, byDefault }

class _Choice {
  const _Choice({
    required this.kind,
    required this.provider,
    required this.label,
    this.detail,
    this.enabled = true,
    this.checked = false,
  });

  final _ChoiceKind kind;
  final VoiceProviderId provider;
  final String label;
  final String? detail;
  final bool enabled;
  final bool checked;
}

/// The chooser's three groups: Call with …, Always use … for the agent, Make
/// … my default. A checked choice picked again clears it.
List<List<_Choice>> _choices(VoiceSettings settings, String agentName) {
  final effective = settings.effective;
  final override = effective == null
      ? null
      : settings.overrideFor(effective.agentId);
  return [
    [
      for (final option in settings.providers)
        _Choice(
          kind: _ChoiceKind.call,
          provider: option.id,
          label: 'Call with ${option.label}',
          detail: _callUnavailable(option),
          enabled: _callUnavailable(option) == null,
        ),
    ],
    if (effective != null)
      [
        for (final option in settings.providers)
          _Choice(
            kind: _ChoiceKind.always,
            provider: option.id,
            label: 'Always use ${option.label} for $agentName',
            checked: override == option.id,
          ),
      ],
    [
      for (final option in settings.providers)
        _Choice(
          kind: _ChoiceKind.byDefault,
          provider: option.id,
          label: 'Make ${option.label} my default',
          checked: settings.userDefault == option.id,
        ),
    ],
  ];
}

Future<void> _pick(
  BuildContext context,
  WidgetRef ref,
  _Choice choice, {
  required VoiceSettings settings,
  required String agentPubkey,
  required String channelId,
  required String agentName,
}) async {
  if (choice.kind == _ChoiceKind.call) {
    await openAgentCall(
      context,
      ref,
      agentPubkey: agentPubkey,
      channelId: channelId,
      agentName: agentName,
      provider: choice.provider,
    );
    return;
  }
  final api = ref.read(agentCallApiProvider);
  if (api == null) return;
  final next = choice.checked ? null : choice.provider;
  String? notice;
  try {
    if (choice.kind == _ChoiceKind.always) {
      final effective = settings.effective;
      if (effective == null) return;
      await api.setVoiceOverride(effective.agentId, next, effective.revision);
    } else {
      await api.setVoiceDefault(next, settings.revision);
    }
  } catch (error) {
    notice = describeVoiceSettingsError(error);
  }
  // Every agent's read may have changed (a default applies to all of them).
  ref.invalidate(agentVoiceSettingsProvider);
  if (notice != null && context.mounted) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(notice)));
  }
}

/// The chooser as a sheet (a long press on the Call button).
Future<void> showAgentCallChooser(
  BuildContext context,
  WidgetRef ref, {
  required String agentPubkey,
  required String channelId,
  required String agentName,
}) async {
  final settings = agentVoiceChoicesNow(ref, agentPubkey);
  if (settings == null) return;
  final picked = await showBuzzModalBottomSheet<_Choice>(
    context: context,
    title: 'Call $agentName',
    builder: (sheetContext) => ListView(
      shrinkWrap: true,
      children: [
        for (final (index, group) in _choices(settings, agentName).indexed) ...[
          if (index > 0) const Divider(height: Grid.xs),
          for (final choice in group)
            ListTile(
              enabled: choice.enabled,
              leading: choice.kind == _ChoiceKind.call
                  ? const Icon(Icons.call_outlined)
                  : Icon(
                      choice.checked ? Icons.check : null,
                      semanticLabel: choice.checked ? 'Selected' : null,
                    ),
              title: Text(choice.label),
              subtitle: choice.detail == null ? null : Text(choice.detail!),
              onTap: () => Navigator.of(sheetContext).pop(choice),
            ),
        ],
      ],
    ),
  );
  if (picked == null || !context.mounted) return;
  await _pick(
    context,
    ref,
    picked,
    settings: settings,
    agentPubkey: agentPubkey,
    channelId: channelId,
    agentName: agentName,
  );
}

/// The read as it stands, without subscribing (for a tap handler).
VoiceSettings? agentVoiceChoicesNow(WidgetRef ref, String agentPubkey) {
  final settings = ref.read(agentVoiceSettingsProvider(agentPubkey)).value;
  return settings != null && settings.providers.length > 1 ? settings : null;
}

/// The chooser as the native bar item's long-press menu: one inline group
/// per section.
List<IosNavigationAction> agentCallChooserActions(
  BuildContext context,
  WidgetRef ref, {
  required VoiceSettings settings,
  required String agentPubkey,
  required String channelId,
  required String agentName,
}) => [
  for (final group in _choices(settings, agentName))
    IosNavigationAction(
      label: '',
      children: [
        for (final choice in group)
          IosNavigationAction(
            label: choice.label,
            subtitle: choice.detail,
            symbol: choice.kind == _ChoiceKind.call ? 'phone' : null,
            selected: choice.checked,
            onPressed: choice.enabled
                ? () => unawaited(
                    _pick(
                      context,
                      ref,
                      choice,
                      settings: settings,
                      agentPubkey: agentPubkey,
                      channelId: channelId,
                      agentName: agentName,
                    ),
                  )
                : null,
          ),
      ],
    ),
];
