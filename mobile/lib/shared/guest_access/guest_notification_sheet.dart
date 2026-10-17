import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../theme/theme.dart';
import '../widgets/modal_presentation.dart';
import 'guest_access_client.dart';
import 'guest_alert_route.dart';
import 'guest_approval_sheet.dart';
import 'resolved_guest_approvals.dart';
import 'settings/guest_digest_page.dart';
import 'settings/guest_requests_page.dart';
import 'settings/guest_safety_page.dart';

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
/// opens the owner review card; an alert shows its text with a "Review"
/// action to the matching guest-access page (from `buzz-guest-alert-kind`,
/// like desktop). Returns `false` for any other kind so the caller keeps its
/// normal navigation.
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
  final destination = kind == _alertKind
      ? guestAlertDestination(_tag(tags, 'buzz-guest-alert-kind'))
      : null;
  final review = await showBuzzModalBottomSheet<bool>(
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
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              content.trim().isEmpty ? 'Your agent sent an alert.' : content,
              style: sheetContext.textTheme.bodyMedium,
            ),
            if (destination != null) ...[
              const SizedBox(height: Grid.xs),
              FilledButton(
                key: const ValueKey('guest-alert-review'),
                onPressed: () => Navigator.of(sheetContext).pop(true),
                child: Text(guestAlertReviewLabel(destination)),
              ),
            ],
          ],
        ),
      ),
    ),
  );
  if (review == true && destination != null && context.mounted) {
    await _openAlertDestination(context, destination);
  }
  return true;
}

Future<void> _openAlertDestination(
  BuildContext context,
  GuestAlertDestination destination,
) async {
  final Widget page;
  switch (destination) {
    case GuestAlertDestination.digest:
      page = const GuestDigestPage();
    case GuestAlertDestination.requests:
      page = const GuestRequestsPage();
    case GuestAlertDestination.adminSafety:
      // Safety review is for organization admins; everyone else stays on
      // the inbox, as on desktop.
      if (!await _isGuestAdmin(context)) {
        if (context.mounted) {
          ScaffoldMessenger.maybeOf(context)?.showSnackBar(
            const SnackBar(
              content: Text('Only organization admins can review this alert'),
            ),
          );
        }
        return;
      }
      page = const GuestSafetyPage();
  }
  if (!context.mounted) return;
  await Navigator.of(
    context,
  ).push(MaterialPageRoute<void>(builder: (_) => page));
}

/// Whether the owner may open org-admin guest safety. Any failure other than
/// a definite "admin required" still opens the page, which shows its own
/// error and retry.
Future<bool> _isGuestAdmin(BuildContext context) async {
  final client = ProviderScope.containerOf(
    context,
    listen: false,
  ).read(guestAccessClientProvider);
  if (client == null) return false;
  try {
    await client.adminOverview();
    return true;
  } catch (error) {
    return !isAdminRequired(error);
  }
}
