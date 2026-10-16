import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../relay/relay.dart';

/// Approval ids this owner decided on this device, so the inbox drops a
/// request at once instead of waiting for the agent's 46041 resolution.
/// Scoped to the active community and identity.
class ResolvedGuestApprovalIds extends Notifier<Set<String>> {
  @override
  Set<String> build() {
    ref.watch(relayConfigProvider);
    return const {};
  }

  void add(String approvalId) {
    if (state.contains(approvalId)) return;
    state = {...state, approvalId};
  }
}

final resolvedGuestApprovalIdsProvider =
    NotifierProvider<ResolvedGuestApprovalIds, Set<String>>(
      ResolvedGuestApprovalIds.new,
    );
