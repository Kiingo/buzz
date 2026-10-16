import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../theme/theme.dart';
import '../widgets/modal_presentation.dart';
import 'guest_approval_sheet.dart';
import 'resolved_guest_approvals.dart';

/// Agent guest-access owner notification kinds (relay kinds 46040–46042).
const _approvalRequestedKind = 46040;
const _approvalResolvedKind = 46041;
const _alertKind = 46042;

/// Whether [kind] is an owner-addressed guest-access notification.
bool isGuestNotificationKind(int kind) =>
    kind == _approvalRequestedKind ||
    kind == _approvalResolvedKind ||
    kind == _alertKind;

String? _tag(List<List<String>> tags, String name) {
  for (final tag in tags) {
    if (tag.length > 1 && tag[0] == name) return tag[1];
  }
  return null;
}

/// Open a guest-access notification from the inbox: an approval request
/// opens the owner review card; an alert shows its text. Returns `false`
/// for any other kind so the caller keeps its normal navigation.
///
/// [onDecided] runs after the owner records a decision, so the caller can
/// refresh its list.
Future<bool> openGuestNotification(
  BuildContext context, {
  required int kind,
  required List<List<String>> tags,
  required String content,
  VoidCallback? onDecided,
}) async {
  if (!isGuestNotificationKind(kind)) return false;
  final approvalId = _tag(tags, 'buzz-guest-approval');
  if (kind == _approvalRequestedKind && approvalId != null) {
    final decided = await showBuzzModalBottomSheet<bool>(
      context: context,
      title: 'Approval request',
      isScrollControlled: true,
      builder: (_) =>
          GuestApprovalSheet(approvalId: approvalId, summary: content),
    );
    if (decided == true) {
      if (context.mounted) {
        ProviderScope.containerOf(
          context,
          listen: false,
        ).read(resolvedGuestApprovalIdsProvider.notifier).add(approvalId);
      }
      onDecided?.call();
    }
    return true;
  }
  if (!context.mounted) return true;
  await showBuzzModalBottomSheet<void>(
    context: context,
    title: kind == _alertKind ? 'Agent alert' : 'Approval request',
    builder: (sheetContext) => SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          Grid.gutter,
          0,
          Grid.gutter,
          Grid.xs,
        ),
        child: Text(
          content.trim().isEmpty ? 'Your agent sent an alert.' : content,
          style: sheetContext.textTheme.bodyMedium,
        ),
      ),
    ),
  );
  return true;
}
