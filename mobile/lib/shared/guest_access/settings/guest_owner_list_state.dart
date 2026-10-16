import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../theme/theme.dart';
import '../../widgets/buzz_loading_indicator.dart';
import 'guest_owner_providers.dart';

/// Loading, error and empty states shared by the guest-access settings
/// lists; [builder] renders the loaded value.
class GuestOwnerListState<T> extends StatelessWidget {
  const GuestOwnerListState({
    super.key,
    required this.value,
    required this.isEmpty,
    required this.emptyText,
    required this.onRetry,
    required this.builder,
  });

  final AsyncValue<T> value;
  final bool Function(T value) isEmpty;
  final String emptyText;
  final VoidCallback onRetry;
  final Widget Function(T value) builder;

  @override
  Widget build(BuildContext context) {
    final muted = context.textTheme.bodyMedium?.copyWith(
      color: context.colors.onSurfaceVariant,
    );
    Widget padded(Widget child) => Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: Grid.gutter,
        vertical: Grid.xs,
      ),
      child: child,
    );
    // Keep showing the last value while a refresh is in flight.
    if (value.hasValue) {
      final data = value.requireValue;
      if (isEmpty(data)) return padded(Text(emptyText, style: muted));
      return builder(data);
    }
    if (value.hasError) {
      return padded(
        Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              guestOwnerErrorText(value.error),
              style: context.textTheme.bodyMedium?.copyWith(
                color: context.colors.error,
              ),
            ),
            const SizedBox(height: Grid.xxs),
            OutlinedButton.icon(
              onPressed: onRetry,
              icon: const Icon(LucideIcons.refreshCw, size: 16),
              label: const Text('Try again'),
            ),
          ],
        ),
      );
    }
    return const Padding(
      padding: EdgeInsets.symmetric(vertical: Grid.lg),
      child: Center(child: BuzzLoadingIndicator(size: 32)),
    );
  }
}
