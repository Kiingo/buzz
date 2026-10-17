/// Where an agent guest alert's "Review" goes, from its
/// `buzz-guest-alert-kind` tag. Mirrors desktop `alertRoute.ts`.
enum GuestAlertDestination {
  /// The owner's daily digest.
  digest,

  /// The owner's guest request log (blocks, rate limits, budget).
  requests,

  /// Org-admin guest safety (suspensions, org-wide patterns). Admin only.
  adminSafety,
}

/// The review destination for an alert of [kind], or `null` when the alert
/// is informational and has nothing to review.
GuestAlertDestination? guestAlertDestination(String? kind) => switch (kind) {
  'daily_digest' => GuestAlertDestination.digest,
  'requester_suspended' || 'org_pattern' => GuestAlertDestination.adminSafety,
  'agent_request_outcome' => null,
  // high_block, requester_rate_limited, budget_exhausted, and alerts from
  // routes that predate the kind tag.
  _ => GuestAlertDestination.requests,
};

/// The button label for [destination].
String guestAlertReviewLabel(GuestAlertDestination destination) =>
    switch (destination) {
      GuestAlertDestination.digest => 'Open digest',
      GuestAlertDestination.requests => 'Review requests',
      GuestAlertDestination.adminSafety => 'Review in Settings',
    };
