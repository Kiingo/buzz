import 'package:flutter/material.dart';

import '../../theme/theme.dart';
import '../guest_owner_copy.dart';

/// A small pill used on guest-access rows: an outcome, a scope or a source.
class GuestBadge extends StatelessWidget {
  const GuestBadge({
    super.key,
    required this.label,
    this.tone = GuestTone.neutral,
  });

  final String label;
  final GuestTone tone;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final appColors = context.appColors;
    final foreground = switch (tone) {
      GuestTone.positive => appColors.success,
      GuestTone.warning => appColors.warning,
      GuestTone.danger => colors.error,
      GuestTone.neutral => colors.onSurfaceVariant,
    };
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: Grid.xxs,
        vertical: Grid.quarter,
      ),
      decoration: BoxDecoration(
        color: foreground.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(Radii.full),
      ),
      child: Text(
        label,
        style: context.textTheme.labelSmall?.copyWith(
          color: foreground,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}
