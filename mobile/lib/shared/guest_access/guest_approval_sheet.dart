import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../theme/buzz_icons.dart';
import '../theme/theme.dart';
import '../widgets/buzz_loading_indicator.dart';
import 'guest_access_client.dart';
import 'guest_access_icons.dart';
import 'guest_approval.dart';
import 'guest_approval_decision.dart';

part 'guest_approval_sheet/details.dart';
part 'guest_approval_sheet/pickers.dart';
part 'guest_approval_sheet/review.dart';

/// One approval, fetched from the guest route (the system of record).
final guestApprovalProvider = FutureProvider.autoDispose
    .family<GuestApproval, String>((ref, approvalId) async {
      final client = ref.watch(guestAccessClientProvider);
      if (client == null) {
        throw const GuestAccessException('guest_route_unavailable');
      }
      return client.approval(approvalId);
    });

/// Owner review of one guest-access approval request, with the same card
/// semantics as desktop: who is asking (TEST badge, route classification,
/// linked-ago, first/Nth request), where the reply goes, the exact draft,
/// the data used and why it was held, a sources picker for owner-data
/// requests (nothing pre-ticked when the request named none), a grant scope,
/// a sentence saying what approving does, and Approve / Edit then approve /
/// Deny / Deny and block.
///
/// Pops `true` once a decision is recorded.
class GuestApprovalSheet extends HookConsumerWidget {
  const GuestApprovalSheet({
    super.key,
    required this.approvalId,
    required this.summary,
  });

  final String approvalId;

  /// The notification's one-line summary, shown when the route is
  /// unavailable.
  final String summary;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final approval = ref.watch(guestApprovalProvider(approvalId));
    final maxHeight = MediaQuery.sizeOf(context).height * 0.85;
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: maxHeight),
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(
            Grid.gutter,
            0,
            Grid.gutter,
            Grid.xs,
          ),
          child: approval.when(
            loading: () => const Padding(
              padding: EdgeInsets.symmetric(vertical: Grid.lg),
              child: Center(child: BuzzLoadingIndicator(size: 32)),
            ),
            error: (error, _) => _ApprovalUnavailable(
              summary: summary,
              message: error is GuestAccessException
                  ? error.message
                  : describeGuestAccessError('request_failed'),
              onRetry: () => ref.invalidate(guestApprovalProvider(approvalId)),
            ),
            data: (value) => _ApprovalReview(
              key: ValueKey(value.approvalId),
              approval: value,
            ),
          ),
        ),
      ),
    );
  }
}

class _ApprovalUnavailable extends StatelessWidget {
  const _ApprovalUnavailable({
    required this.summary,
    required this.message,
    required this.onRetry,
  });

  final String summary;
  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (summary.trim().isNotEmpty) ...[
          Text(summary, style: context.textTheme.bodyLarge),
          const SizedBox(height: Grid.twelve),
        ],
        Text(
          message,
          style: context.textTheme.bodyMedium?.copyWith(
            color: context.colors.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: Grid.xs),
        Align(
          alignment: Alignment.centerLeft,
          child: OutlinedButton.icon(
            onPressed: onRetry,
            icon: const Icon(BuzzIcons.refreshCw, size: 16),
            label: const Text('Try again'),
          ),
        ),
      ],
    );
  }
}
