import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../../theme/buzz_icons.dart';
import '../../theme/theme.dart';
import '../../widgets/app_list.dart';
import '../../widgets/app_list_card.dart';
import '../guest_access_client.dart';
import 'guest_access_settings_page.dart';

/// The Settings entry for managing how other people reach the owner's
/// agents. Hidden when this build has no guest route, when the active
/// community isn't the one the route serves, or without a signing key.
class GuestAccessSettingsSection extends ConsumerWidget {
  const GuestAccessSettingsSection({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (ref.watch(guestAccessClientProvider) == null) {
      return const SizedBox.shrink();
    }
    return AppListCard(
      label: 'Guest access',
      verticalPadding: Grid.twelve,
      children: [
        AppListRow(
          key: const ValueKey('guest-access-settings-row'),
          icon: BuzzIcons.shieldCheck,
          title: 'Agent guest access',
          subtitle: 'Grants, blocks, recent requests and the daily digest',
          trailing: Icon(
            BuzzIcons.chevronRight,
            size: 18,
            color: context.colors.onSurfaceVariant,
          ),
          onTap: () => Navigator.of(context).push(
            MaterialPageRoute<void>(
              builder: (_) => const GuestAccessSettingsPage(),
            ),
          ),
        ),
      ],
    );
  }
}
