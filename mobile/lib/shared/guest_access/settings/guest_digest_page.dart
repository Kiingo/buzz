import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../theme/theme.dart';
import '../../widgets/app_list.dart';
import '../../widgets/app_list_card.dart';
import '../guest_approval.dart';
import '../guest_owner_copy.dart';
import '../guest_owner_records.dart';
import 'guest_owner_list_state.dart';
import 'guest_owner_page_scaffold.dart';
import 'guest_owner_providers.dart';

part 'guest_digest_page/day_picker.dart';
part 'guest_digest_page/digest_summary.dart';

/// The daily digest across all of the owner's agents, for one UTC day
/// (yesterday by default). The route builds it on request and sends a
/// digest notification after days with guest activity; there are no digest
/// settings, so this view is read-only.
class GuestDigestPage extends HookConsumerWidget {
  const GuestDigestPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final date = useState(defaultDigestDate());
    final digest = ref.watch(ownerGuestDigestProvider(date.value));
    return GuestOwnerPageScaffold(
      title: 'Daily digest',
      intro:
          'A summary of guest requests across all your agents for one day '
          '(UTC). You get a digest notification after days with guest '
          "activity. There's nothing to set up here.",
      children: [
        _DayPicker(date: date.value, onChanged: (day) => date.value = day),
        GuestOwnerListState<GuestDigest>(
          value: digest,
          isEmpty: (value) => value.isQuiet,
          emptyText: 'No guest requests that day.',
          onRetry: () => ref.invalidate(ownerGuestDigestProvider(date.value)),
          builder: (value) => _DigestSummary(digest: value),
        ),
      ],
    );
  }
}
