import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../../theme/theme.dart';
import '../../widgets/app_list_card.dart';
import '../../widgets/app_list_inset.dart';
import '../guest_approval.dart';
import '../guest_owner_copy.dart';
import '../guest_owner_records.dart';
import 'guest_agent_names.dart';
import 'guest_badge.dart';
import 'guest_owner_list_state.dart';
import 'guest_owner_page_scaffold.dart';
import 'guest_owner_providers.dart';

part 'guest_grants_page/grant_row.dart';

/// Active grants across the owner's agents, each with Revoke.
class GuestGrantsPage extends ConsumerWidget {
  const GuestGrantsPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final grants = ref.watch(ownerGuestGrantsProvider);
    final names = ref.watch(guestAgentNamesProvider);
    return GuestOwnerPageScaffold(
      title: 'Grants',
      intro:
          "People you've allowed to get answers that use information only "
          'you can see. Revoking takes effect within 10 minutes.',
      children: [
        GuestOwnerListState<List<GuestGrant>>(
          value: grants,
          isEmpty: (rows) => activeGrants(rows).isEmpty,
          emptyText:
              'No active grants. Grants are created when you approve a '
              'request.',
          onRetry: () => ref.invalidate(ownerGuestGrantsProvider),
          builder: (rows) => AppListCard(
            verticalPadding: Grid.twelve,
            dividerIndent: Grid.xs,
            children: [
              for (final grant in activeGrants(rows))
                _GrantRow(
                  key: ValueKey(grant.grantId),
                  grant: grant,
                  agentLabel: guestAgentScopeLabel(
                    names,
                    grant.guestEndpointId,
                  ),
                ),
            ],
          ),
        ),
      ],
    );
  }
}
