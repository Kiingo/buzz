part of '../guest_access_settings_page.dart';

class _ManageCard extends ConsumerWidget {
  const _ManageCard();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    String? count<T>(
      AsyncValue<List<T>> value, [
      List<T> Function(List<T>)? f,
    ]) {
      if (!value.hasValue) return null;
      final rows = f == null ? value.requireValue : f(value.requireValue);
      return '${rows.length}';
    }

    final grants = count(
      ref.watch(ownerGuestGrantsProvider),
      (rows) => activeGrants(rows),
    );
    final blocks = count(ref.watch(ownerGuestBlocksProvider));
    final shared = count(ref.watch(ownerGuestShareablesProvider));
    final suggestions = count(ref.watch(ownerGuestSuggestionsProvider));
    final chevron = Icon(
      BuzzIcons.chevronRight,
      size: 18,
      color: context.colors.onSurfaceVariant,
    );

    return AppListCard(
      label: 'Manage',
      verticalPadding: Grid.twelve,
      children: [
        AppListRow(
          key: const ValueKey('guest-access-grants'),
          icon: BuzzIcons.key,
          title: 'Grants',
          subtitle: 'People you let get answers without asking you',
          value: grants,
          trailing: chevron,
          onTap: () => _push(context, const GuestGrantsPage()),
        ),
        AppListRow(
          key: const ValueKey('guest-access-requests'),
          icon: GuestAccessIcons.history,
          title: 'Recent requests',
          subtitle: 'Who asked, the outcome and the safety check',
          trailing: chevron,
          onTap: () => _push(context, const GuestRequestsPage()),
        ),
        AppListRow(
          key: const ValueKey('guest-access-blocks'),
          icon: GuestAccessIcons.ban,
          title: 'Blocked people',
          value: blocks,
          trailing: chevron,
          onTap: () => _push(context, const GuestBlocksPage()),
        ),
        AppListRow(
          key: const ValueKey('guest-access-shared'),
          icon: BuzzIcons.share2,
          title: 'Shared via your agents',
          subtitle: 'Status and notes anyone in your org may be told',
          value: shared,
          trailing: chevron,
          onTap: () => _push(context, const GuestSharedPage()),
        ),
        AppListRow(
          key: const ValueKey('guest-access-suggestions'),
          icon: BuzzIcons.lightbulb,
          title: 'Suggestions',
          subtitle: 'Grants your agents proposed or you keep approving',
          value: suggestions,
          trailing: chevron,
          onTap: () => _push(context, const GuestSuggestionsPage()),
        ),
        AppListRow(
          key: const ValueKey('guest-access-digest'),
          icon: GuestAccessIcons.calendarMonth,
          title: 'Daily digest',
          trailing: chevron,
          onTap: () => _push(context, const GuestDigestPage()),
        ),
      ],
    );
  }
}

/// Org-admin guest safety, shown only to organization admins.
class _AdminCard extends ConsumerWidget {
  const _AdminCard();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final safety = ref.watch(adminGuestSafetyProvider);
    if (!safety.hasValue && !safety.hasError) return const SizedBox.shrink();
    if (safety.hasError && isAdminRequired(safety.error)) {
      return const SizedBox.shrink();
    }
    final overview = safety.value;
    final open = overview == null
        ? null
        : overview.alerts.length + overview.suspended.length;
    return AppListCard(
      label: 'Organization',
      verticalPadding: Grid.twelve,
      children: [
        AppListRow(
          key: const ValueKey('guest-access-safety'),
          icon: BuzzIcons.shieldAlert,
          title: 'Agent guest safety',
          subtitle: 'For admins: suspensions and unusual request patterns',
          value: open == null || open == 0 ? null : '$open',
          trailing: Icon(
            BuzzIcons.chevronRight,
            size: 18,
            color: context.colors.onSurfaceVariant,
          ),
          onTap: () => _push(context, const GuestSafetyPage()),
        ),
      ],
    );
  }
}
