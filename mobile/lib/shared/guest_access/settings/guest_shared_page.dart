import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../../theme/theme.dart';
import '../../widgets/app_list_card.dart';
import '../../widgets/app_list_inset.dart';
import '../guest_owner_copy.dart';
import '../guest_owner_records.dart';
import 'guest_agent_names.dart';
import 'guest_owner_list_state.dart';
import 'guest_owner_page_scaffold.dart';
import 'guest_owner_providers.dart';

part 'guest_shared_page/share_form.dart';
part 'guest_shared_page/shared_row.dart';

/// Items marked "shared via my agent": the only things otherwise private to
/// the owner that their agents may tell anyone in the org who asks, without
/// approval. Add a status or a note; stop sharing any item.
class GuestSharedPage extends ConsumerWidget {
  const GuestSharedPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final shareables = ref.watch(ownerGuestShareablesProvider);
    final names = ref.watch(guestAgentNamesProvider);
    return GuestOwnerPageScaffold(
      title: 'Shared via your agents',
      intro:
          'Mark notes, decisions and your status as "shared via my agent". '
          'Anyone in your org who asks your agents can be told these, without '
          'your approval.',
      children: [
        const _ShareForm(),
        GuestOwnerListState<List<GuestShareable>>(
          value: shareables,
          isEmpty: (rows) => rows.isEmpty,
          emptyText: 'Nothing is shared yet.',
          onRetry: () => ref.invalidate(ownerGuestShareablesProvider),
          builder: (rows) => AppListCard(
            label: 'Shared now',
            verticalPadding: Grid.twelve,
            dividerIndent: Grid.xs,
            children: [
              for (final row in rows)
                _SharedRow(
                  key: ValueKey(row.shareableId),
                  item: row,
                  agentLabel: guestAgentScopeLabel(names, row.guestEndpointId),
                ),
            ],
          ),
        ),
      ],
    );
  }
}
