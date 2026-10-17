import 'package:buzz/shared/guest_access/guest_alert_route.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('routes each alert kind like desktop', () {
    expect(guestAlertDestination('daily_digest'), GuestAlertDestination.digest);
    for (final kind in ['requester_suspended', 'org_pattern']) {
      expect(guestAlertDestination(kind), GuestAlertDestination.adminSafety);
    }
    for (final kind in [
      'high_block',
      'requester_rate_limited',
      'budget_exhausted',
      null,
      'Not A Kind!',
    ]) {
      expect(guestAlertDestination(kind), GuestAlertDestination.requests);
    }
    expect(guestAlertDestination('agent_request_outcome'), isNull);
  });

  test('labels the review action', () {
    expect(guestAlertReviewLabel(GuestAlertDestination.digest), 'Open digest');
    expect(
      guestAlertReviewLabel(GuestAlertDestination.requests),
      'Review requests',
    );
    expect(
      guestAlertReviewLabel(GuestAlertDestination.adminSafety),
      'Review in Settings',
    );
  });
}
