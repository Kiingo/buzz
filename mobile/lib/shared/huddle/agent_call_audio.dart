import 'package:hooks_riverpod/hooks_riverpod.dart';

/// One audio owner: true while a 1:1 agent call holds the phone's audio (set
/// by the call). A Huddle never starts or joins beside it, or Huddle members
/// would be heard as the caller's asks and the agent's voice would play into
/// the room. The call refuses to start while a Huddle is in session.
final agentCallAudioBusyProvider = NotifierProvider<AudioOwnerFlag, bool>(
  AudioOwnerFlag.new,
);

/// True while a Huddle start is under way (from before it is announced until
/// it joins or rolls back), set by the Huddle controller. A call refuses
/// then too, so a Huddle is never announced and then rolled back for it.
final huddleStartingProvider = NotifierProvider<AudioOwnerFlag, bool>(
  AudioOwnerFlag.new,
);

/// One side's claim on the phone's audio.
final class AudioOwnerFlag extends Notifier<bool> {
  @override
  bool build() => false;

  void update(bool busy) {
    if (state != busy) state = busy;
  }
}

/// What a refused Huddle start or join says.
const agentCallHuddleRefusal =
    'End your agent call before starting or joining a Huddle.';
