import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../../theme/theme.dart';
import '../../widgets/frosted_app_bar.dart';
import '../../widgets/frosted_scaffold.dart';
import 'guest_owner_providers.dart';

/// The page frame for each guest-access settings screen: a titled frosted
/// app bar, an optional intro paragraph, and pull to refresh that reloads
/// every owner read.
class GuestOwnerPageScaffold extends ConsumerWidget {
  const GuestOwnerPageScaffold({
    super.key,
    required this.title,
    this.intro,
    required this.children,
  });

  final String title;
  final String? intro;
  final List<Widget> children;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return FrostedScaffold(
      useUtilitySurfaceTheme: true,
      appBar: FrostedAppBar(centerTitle: true, title: Text(title)),
      body: RefreshIndicator(
        edgeOffset: frostedAppBarHeight(context),
        onRefresh: () async => invalidateGuestOwnerData(ref),
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: EdgeInsets.only(
            top: frostedAppBarHeight(context),
            bottom: Grid.lg,
          ),
          children: [
            if (intro != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(
                  Grid.gutter,
                  Grid.xxs,
                  Grid.gutter,
                  Grid.xxs,
                ),
                child: Text(
                  intro!,
                  style: context.textTheme.bodyMedium?.copyWith(
                    color: context.colors.onSurfaceVariant,
                  ),
                ),
              ),
            ...children,
          ],
        ),
      ),
    );
  }
}
