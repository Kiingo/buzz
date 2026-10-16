import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../../theme/theme.dart';
import '../../widgets/modal_presentation.dart';
import '../guest_access_client.dart';
import '../guest_owner_records.dart';

export '../guest_access_client.dart'
    show GuestAccessClient, GuestAccessException, GuestAccessOwnerApi;

GuestAccessClient _client(Ref ref) {
  final client = ref.watch(guestAccessClientProvider);
  if (client == null) {
    throw const GuestAccessException('guest_route_unavailable');
  }
  return client;
}

/// The owner's agents registered with the guest route.
final ownerGuestAgentsProvider =
    FutureProvider.autoDispose<List<GuestOwnerAgent>>(
      (ref) => _client(ref).ownerAgents(),
    );

/// The owner's grants across all agents.
final ownerGuestGrantsProvider = FutureProvider.autoDispose<List<GuestGrant>>(
  (ref) => _client(ref).grants(),
);

/// People the owner blocked.
final ownerGuestBlocksProvider = FutureProvider.autoDispose<List<GuestBlock>>(
  (ref) => _client(ref).blocks(),
);

/// One access-log page: `agent` `null` is every agent, `cursor` `null` the
/// newest page.
typedef GuestAccessLogKey = ({String? agent, String? cursor});

final ownerGuestAccessLogProvider = FutureProvider.autoDispose
    .family<GuestAccessLogPage, GuestAccessLogKey>(
      (ref, key) => _client(
        ref,
      ).accessLog(guestEndpointId: key.agent, cursor: key.cursor),
    );

/// The digest for one UTC day (YYYY-MM-DD).
final ownerGuestDigestProvider = FutureProvider.autoDispose
    .family<GuestDigest, String>((ref, date) => _client(ref).digest(date));

/// Items shared via the owner's agents.
final ownerGuestShareablesProvider =
    FutureProvider.autoDispose<List<GuestShareable>>(
      (ref) => _client(ref).shareables(),
    );

/// Open learned-grant suggestions.
final ownerGuestSuggestionsProvider =
    FutureProvider.autoDispose<List<GuestSuggestion>>(
      (ref) => _client(ref).suggestions(),
    );

/// Org-admin guest safety. Errors with `admin_required` for non-admins;
/// callers hide the surface on it.
final adminGuestSafetyProvider = FutureProvider.autoDispose<GuestAdminOverview>(
  (ref) => _client(ref).adminOverview(),
);

/// Refresh every owner-side guest-access read.
void invalidateGuestOwnerData(WidgetRef ref) {
  ref
    ..invalidate(ownerGuestAgentsProvider)
    ..invalidate(ownerGuestGrantsProvider)
    ..invalidate(ownerGuestBlocksProvider)
    ..invalidate(ownerGuestAccessLogProvider)
    ..invalidate(ownerGuestDigestProvider)
    ..invalidate(ownerGuestShareablesProvider)
    ..invalidate(ownerGuestSuggestionsProvider)
    ..invalidate(adminGuestSafetyProvider);
}

/// Plain-language text for any error a guest-access call raised.
String guestOwnerErrorText(Object? error) => error is GuestAccessException
    ? error.message
    : describeGuestAccessError('request_failed');

/// Run one owner change against the route, then refresh every owner read.
/// Shows [done] (if any) or the route's error in a snack bar. Returns
/// whether the change was recorded.
Future<bool> runGuestOwnerAction(
  BuildContext context,
  WidgetRef ref,
  Future<void> Function(GuestAccessClient client) action, {
  String? done,
}) async {
  final messenger = ScaffoldMessenger.maybeOf(context);
  final client = ref.read(guestAccessClientProvider);
  if (client == null) {
    messenger?.showSnackBar(
      SnackBar(
        content: Text(describeGuestAccessError('guest_route_unavailable')),
      ),
    );
    return false;
  }
  try {
    await action(client);
  } catch (error) {
    debugPrint('Guest access change failed: $error');
    messenger?.showSnackBar(
      SnackBar(content: Text(guestOwnerErrorText(error))),
    );
    return false;
  }
  if (context.mounted) invalidateGuestOwnerData(ref);
  if (done != null) messenger?.showSnackBar(SnackBar(content: Text(done)));
  return true;
}

/// Ask before a change; resolves `true` when the owner confirms.
Future<bool> confirmGuestOwnerAction(
  BuildContext context, {
  required String title,
  required String message,
  required String confirmLabel,
  bool destructive = true,
}) async {
  final confirmed = await showBuzzDialog<bool>(
    context: context,
    builder: (dialogContext) => AlertDialog(
      title: Text(title),
      content: Text(message),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(dialogContext).pop(false),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () => Navigator.of(dialogContext).pop(true),
          style: destructive
              ? FilledButton.styleFrom(
                  backgroundColor: dialogContext.colors.error,
                )
              : null,
          child: Text(confirmLabel),
        ),
      ],
    ),
  );
  return confirmed ?? false;
}
