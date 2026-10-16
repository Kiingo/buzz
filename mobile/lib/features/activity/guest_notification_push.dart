import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../../shared/deeplink/deep_link.dart';
import '../../shared/guest_access/guest_notification_sheet.dart';
import 'activity_provider.dart';
import 'feed_item.dart';

/// Opens the owner review for a tapped guest-access notification push.
///
/// The push carries only the event ID, so the event is taken from a fresh
/// inbox load, which already applies the trust rules (the owner's own agents,
/// addressed only to the owner, not yet resolved). An event that is no longer
/// there was resolved or is not trusted, and only a notice is shown.
Future<void> openGuestNotificationFromPush(
  BuildContext context,
  WidgetRef ref,
  GuestNotificationDeepLink link,
) async {
  final messenger = ScaffoldMessenger.maybeOf(context);
  final eventId = link.eventId.toLowerCase();
  final HomeFeedResponse feed;
  try {
    feed = await ref.refresh(activityProvider.future);
  } catch (error) {
    debugPrint(
      'notification-routing: failed to load guest notification $eventId: $error',
    );
    messenger?.showSnackBar(
      const SnackBar(content: Text('Could not load the notification')),
    );
    return;
  }
  final item = feed.needsAction
      .where((candidate) => candidate.id.toLowerCase() == eventId)
      .firstOrNull;
  if (!context.mounted) return;
  if (item == null) {
    messenger?.showSnackBar(
      const SnackBar(content: Text('This request has already been handled')),
    );
    return;
  }
  await openGuestNotification(
    context,
    kind: item.kind,
    tags: item.tags,
    content: item.content,
    onDecided: () {
      if (context.mounted) ref.invalidate(activityProvider);
    },
  );
}
