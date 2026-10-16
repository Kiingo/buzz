import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:nostr/nostr.dart' as nostr;

import '../crypto/nip44.dart';
import '../relay/relay.dart';
import 'guest_access_client.dart';
import 'guest_approval.dart';

/// What the owner chose on the approval card.
@immutable
class GuestDecisionInput {
  const GuestDecisionInput({
    required this.decision,
    this.editedText,
    this.grant,
    this.grantedSources,
  });

  final ApprovalDecision decision;
  final String? editedText;

  /// The decision's `grant` body, or `null` for a one-time approval.
  final Map<String, Object>? grant;

  /// Owner-data requests: the sources released to the re-run.
  final List<String>? grantedSources;
}

/// Sends the owner-signed observer control frame that tells an agent's
/// harness to clear its pending state and publish at once.
typedef GuestControlSender =
    Future<void> Function(String agentPubkey, Map<String, Object?> payload);

/// Record a decision. The decision API is the system of record and runs
/// first; only after it succeeds does the control frame go to the agent. A
/// failed frame is harmless: the harness also polls its outbox and sees the
/// 46041 resolution. Matches desktop's `submitApprovalDecision`.
Future<({bool alreadyDecided})> submitGuestApprovalDecision({
  required GuestAccessClient client,
  required GuestApproval approval,
  required GuestDecisionInput input,
  required String idempotencyKey,
  GuestControlSender? sendControl,
}) async {
  final approving =
      input.decision == ApprovalDecision.approve ||
      input.decision == ApprovalDecision.approveEdited;
  var alreadyDecided = false;
  try {
    await client.decide(
      approval.approvalId,
      decision: input.decision,
      editedText: input.editedText,
      grant: approving ? input.grant : null,
      grantedSources: input.decision == ApprovalDecision.approve
          ? input.grantedSources
          : null,
      idempotencyKey: idempotencyKey,
    );
  } on GuestAccessException catch (error) {
    if (error.code != 'approval_already_decided') rethrow;
    alreadyDecided = true;
  }
  final agentPubkey = approval.agentPubkey;
  if (!alreadyDecided && agentPubkey != null && sendControl != null) {
    try {
      await sendControl(agentPubkey, {
        'type': approving ? 'approve_guest_reply' : 'deny_guest_reply',
        'approvalId': approval.approvalId,
        if (approval.guestTurnId != null) 'guestTurnId': approval.guestTurnId,
      });
    } catch (error) {
      debugPrint('Guest approval control frame not delivered: $error');
    }
  }
  return (alreadyDecided: alreadyDecided);
}

/// The observer control frame: NIP-44 to the agent, `p` = agent,
/// `agent` = agent, `frame` = control (buzz-sdk `build_agent_observer_frame`).
final guestControlSenderProvider = Provider<GuestControlSender?>((ref) {
  final nsec = ref.watch(relayConfigProvider.select((config) => config.nsec));
  if (nsec == null || nsec.isEmpty) return null;
  final session = ref.watch(relaySessionProvider.notifier);
  return (agentPubkey, payload) async {
    final privkeyHex = nostr.Nip19.decode(payload: nsec).data;
    if (privkeyHex.isEmpty) return;
    final agent = agentPubkey.toLowerCase();
    final encrypted = nip44Encrypt(
      getConversationKey(privkeyHex, agent),
      jsonEncode(payload),
    );
    await SignedEventRelay(session: session, nsec: nsec).submit(
      kind: EventKind.agentObserverFrame,
      content: encrypted,
      tags: [
        ['p', agent],
        ['agent', agent],
        ['frame', 'control'],
      ],
    );
  };
});
