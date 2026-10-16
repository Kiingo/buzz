import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../../profile/user_cache_provider.dart';
import '../../theme/theme.dart';
import '../../widgets/app_list_card.dart';
import '../../widgets/app_list_inset.dart';
import '../guest_approval.dart';
import '../guest_owner_copy.dart';
import '../guest_owner_records.dart';
import 'guest_badge.dart';
import 'guest_owner_list_state.dart';
import 'guest_owner_page_scaffold.dart';
import 'guest_owner_providers.dart';

part 'guest_safety_page/safety_rows.dart';

/// For organization admins: org-wide guest safety alerts (suspensions,
/// unusual request patterns) with Mark reviewed, and people whose guest
/// access is suspended with Restore access. Matches desktop's Settings →
/// Profile guest safety card.
class GuestSafetyPage extends ConsumerWidget {
  const GuestSafetyPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final safety = ref.watch(adminGuestSafetyProvider);
    return GuestOwnerPageScaffold(
      title: 'Agent guest safety',
      intro:
          'For organization admins. People who repeatedly send risky requests '
          "to colleagues' agents show up here. A suspended person can't ask "
          'any agent until you restore them.',
      children: [
        GuestOwnerListState<GuestAdminOverview>(
          value: safety,
          isEmpty: (value) => value.isEmpty,
          emptyText: 'Nothing needs review. Nobody is suspended.',
          onRetry: () => ref.invalidate(adminGuestSafetyProvider),
          builder: (value) => Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (value.suspended.isNotEmpty)
                AppListCard(
                  label: 'Suspended',
                  verticalPadding: Grid.twelve,
                  dividerIndent: Grid.xs,
                  children: [
                    for (final person in value.suspended)
                      _SuspendedRow(
                        key: ValueKey(person.pubkey),
                        person: person,
                      ),
                  ],
                ),
              if (value.alerts.isNotEmpty)
                AppListCard(
                  label: 'Alerts',
                  verticalPadding: Grid.twelve,
                  dividerIndent: Grid.xs,
                  children: [
                    for (final alert in value.alerts)
                      _AlertRow(key: ValueKey(alert.alertId), alert: alert),
                  ],
                ),
            ],
          ),
        ),
      ],
    );
  }
}

/// A person's Buzz display name from the profile cache, or a short key.
String _personName(WidgetRef ref, String? pubkey) {
  if (pubkey == null || pubkey.isEmpty) return 'Someone';
  final profile = ref.watch(
    userCacheProvider.select((cache) => cache[pubkey.toLowerCase()]),
  );
  return requesterLabel(
    GuestRequester(pubkey: pubkey, displayName: profile?.displayName),
  );
}
