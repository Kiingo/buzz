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
import 'guest_owner_list_state.dart';
import 'guest_owner_page_scaffold.dart';
import 'guest_owner_providers.dart';

part 'guest_blocks_page/block_row.dart';

/// People blocked from the owner's agents, each with Unblock.
class GuestBlocksPage extends ConsumerWidget {
  const GuestBlocksPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final blocks = ref.watch(ownerGuestBlocksProvider);
    final names = ref.watch(guestAgentNamesProvider);
    return GuestOwnerPageScaffold(
      title: 'Blocked people',
      intro:
          'Blocked people get no answers from your agents. Block someone from '
          'Recent requests or when you decline a request.',
      children: [
        GuestOwnerListState<List<GuestBlock>>(
          value: blocks,
          isEmpty: (rows) => rows.isEmpty,
          emptyText: 'Nobody is blocked.',
          onRetry: () => ref.invalidate(ownerGuestBlocksProvider),
          builder: (rows) => AppListCard(
            verticalPadding: Grid.twelve,
            dividerIndent: Grid.xs,
            children: [
              for (final block in rows)
                _BlockRow(
                  key: ValueKey(block.blockId),
                  block: block,
                  agentLabel: guestAgentScopeLabel(
                    names,
                    block.guestEndpointId,
                  ),
                ),
            ],
          ),
        ),
      ],
    );
  }
}
