import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../../theme/theme.dart';
import '../../widgets/app_list_card.dart';
import '../../widgets/app_list_inset.dart';
import '../../widgets/filter_chip_bar.dart';
import '../guest_approval.dart';
import '../guest_owner_copy.dart';
import '../guest_owner_records.dart';
import 'guest_agent_names.dart';
import 'guest_badge.dart';
import 'guest_owner_list_state.dart';
import 'guest_owner_page_scaffold.dart';
import 'guest_owner_providers.dart';

part 'guest_requests_page/log_page.dart';
part 'guest_requests_page/request_row.dart';

/// Rows per access-log page; a full page means there may be more.
const _pageSize = 50;

/// Recent guest requests (the access log): who asked, the outcome, the data
/// used and the safety check, newest first, with Block on each requester.
/// Filter by agent; older requests load a page at a time.
class GuestRequestsPage extends HookConsumerWidget {
  const GuestRequestsPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final agent = useState<String?>(null);
    // Page cursors: `null` is the newest page, then each page's next cursor.
    final cursors = useState<List<String?>>(const [null]);
    final agents = ref.watch(ownerGuestAgentsProvider).value ?? const [];
    final blocked = {
      for (final block
          in ref.watch(ownerGuestBlocksProvider).value ?? const <GuestBlock>[])
        block.pubkey,
    };

    return GuestOwnerPageScaffold(
      title: 'Recent requests',
      intro:
          'Questions other people asked your agents. Message text is kept '
          'only for blocked or high-risk requests, for 30 days.',
      children: [
        if (agents.length > 1)
          FilterChipBar<String?>(
            items: [
              const FilterChipItem(id: null, label: 'All agents'),
              for (final row in agents)
                FilterChipItem(
                  id: row.guestEndpointId,
                  label: row.displayName ?? 'Agent',
                ),
            ],
            selected: agent.value,
            onSelected: (id) {
              agent.value = id;
              cursors.value = const [null];
            },
          ),
        for (var index = 0; index < cursors.value.length; index++)
          _LogPage(
            key: ValueKey('${agent.value}:${cursors.value[index]}'),
            logKey: (agent: agent.value, cursor: cursors.value[index]),
            first: index == 0,
            last: index == cursors.value.length - 1,
            blocked: blocked,
            onMore: (cursor) => cursors.value = [...cursors.value, cursor],
          ),
      ],
    );
  }
}
