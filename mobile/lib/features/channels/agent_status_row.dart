import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../../shared/profile/user_cache_provider.dart';
import '../../shared/utils/string_utils.dart';
import '../../shared/theme/theme.dart';
import 'timeline_message.dart';

/// Plain, signer-attributed system status without chat answer or edit actions.
class AgentStatusRow extends HookConsumerWidget {
  final TimelineMessage message;

  const AgentStatusRow({super.key, required this.message});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final status = message.systemEvent;
    if (status?.type != SystemEventType.agentStatus ||
        message.parentId == null) {
      return const SizedBox.shrink();
    }
    final pk = message.pubkey.toLowerCase();
    final profile = ref.watch(userCacheProvider.select((cache) => cache[pk]));
    final label = profile?.label ?? shortPubkey(message.pubkey);
    return Padding(
      key: const ValueKey('agent-operational-status'),
      padding: const EdgeInsets.symmetric(vertical: Grid.xxs),
      child: Text(
        '$label · System status: ${status?.statusText}',
        style: context.textTheme.bodySmall?.copyWith(
          color: context.colors.onSurfaceVariant,
        ),
      ),
    );
  }
}
