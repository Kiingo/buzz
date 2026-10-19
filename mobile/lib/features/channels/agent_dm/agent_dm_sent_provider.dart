import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../../../shared/relay/relay.dart';
import '../channel.dart';
import '../send_message_provider.dart';

/// Where one card answer or action tap from this client stands.
enum AgentDmSendStatus {
  /// The message is being signed and delivered.
  sending,

  /// The relay accepted the message.
  sent,
}

/// Card answers and action taps sent from this client in this session, keyed
/// by [agentDmAnswerKey] or [agentDmActionKey]. Survives row recycling; the
/// loaded events carry the same facts across restarts.
final agentDmSentProvider =
    NotifierProvider<AgentDmSentNotifier, Map<String, AgentDmSendStatus>>(
      AgentDmSentNotifier.new,
    );

/// Key for an answer to [askId] in [channelId].
String agentDmAnswerKey(String channelId, String askId) =>
    '$channelId|answer|$askId';

/// Key for the action buttons under message [messageId] in [channelId].
String agentDmActionKey(String channelId, String messageId) =>
    '$channelId|action|$messageId';

/// Tracks in-flight and accepted agent DM sends. Cleared on identity or
/// community change.
class AgentDmSentNotifier extends Notifier<Map<String, AgentDmSendStatus>> {
  @override
  Map<String, AgentDmSendStatus> build() {
    ref.watch(myPubkeyProvider);
    ref.watch(relayConfigProvider.select((config) => config.baseUrl));
    return const {};
  }

  /// Sends one message for [key] unless one is already sending or sent.
  /// Returns false when skipped. A failed send clears [key] so the person can
  /// try again, and rethrows.
  Future<bool> send(String key, Future<void> Function() deliver) async {
    if (state.containsKey(key)) return false;
    state = {...state, key: AgentDmSendStatus.sending};
    try {
      await deliver();
    } catch (_) {
      state = {...state}..remove(key);
      rethrow;
    }
    state = {...state, key: AgentDmSendStatus.sent};
    return true;
  }
}

/// Sends [content] with [tags] as an ordinary user-signed top-level kind 9
/// message in [channel], through the same path as the composer.
///
/// The composer's extra-tag seam carries the marker tags; a DM still
/// addresses its members as it does for typed messages.
Future<void> sendAgentDmMessage(
  WidgetRef ref, {
  required Channel channel,
  required String content,
  List<List<String>> tags = const [],
  bool personal = false,
}) {
  final sender = ref.read(
    personal ? meSendMessageProvider : sendMessageProvider,
  );
  return sender.call(
    channelId: channel.id,
    content: content,
    mentionPubkeys: const [],
    channel: channel,
    mediaTags: tags,
  );
}
