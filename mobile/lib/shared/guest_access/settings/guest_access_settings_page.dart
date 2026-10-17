import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../../theme/buzz_icons.dart';
import '../../theme/theme.dart';
import '../../widgets/app_list.dart';
import '../../widgets/app_list_card.dart';
import '../guest_access_client.dart';
import '../guest_access_icons.dart';
import '../guest_owner_copy.dart';
import '../guest_owner_records.dart';
import 'guest_blocks_page.dart';
import 'guest_digest_page.dart';
import 'guest_grants_page.dart';
import 'guest_owner_list_state.dart';
import 'guest_owner_page_scaffold.dart';
import 'guest_owner_providers.dart';
import 'guest_requests_page.dart';
import 'guest_safety_page.dart';
import 'guest_shared_page.dart';
import 'guest_suggestions_page.dart';

part 'guest_access_settings_page/agents_card.dart';
part 'guest_access_settings_page/manage_card.dart';

/// Settings → Agent guest access: the owner-side management desktop has in
/// each agent's Access dialog, across all of the owner's agents. Each agent's
/// hosted-answer switch (its guest policy), then grants, recent requests,
/// blocked people, shared items, suggestions and the daily digest, plus the
/// org-admin safety review for admins.
class GuestAccessSettingsPage extends ConsumerWidget {
  const GuestAccessSettingsPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return const GuestOwnerPageScaffold(
      title: 'Agent guest access',
      intro:
          'How other people and their agents get answers from your agents. '
          'Their questions are answered by the hosted guest service, never on '
          'your devices. Anything only you can see waits for your approval.',
      children: [_AgentsCard(), _ManageCard(), _AdminCard()],
    );
  }
}

void _push(BuildContext context, Widget page) {
  unawaited(
    Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => page)),
  );
}
