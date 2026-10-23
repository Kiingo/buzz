import 'package:hooks_riverpod/hooks_riverpod.dart';

/// One audio owner: true while a 1:1 agent call holds the phone's audio (set
/// by the call). A Huddle never starts or joins beside it, or Huddle members
/// would be heard as the caller's asks and the agent's voice would play into
/// the room. The call refuses to start while a Huddle is in session.
final agentCallAudioBusyProvider = NotifierProvider<AgentCallAudioBusy, bool>(
  AgentCallAudioBusy.new,
);

final class AgentCallAudioBusy extends Notifier<bool> {
  @override
  bool build() => false;

  void update(bool busy) {
    if (state != busy) state = busy;
  }
}

/// What a refused Huddle start or join says.
const agentCallHuddleRefusal =
    'End your agent call before starting or joining a Huddle.';
