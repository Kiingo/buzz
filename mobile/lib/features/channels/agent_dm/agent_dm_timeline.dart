import 'package:flutter/foundation.dart';

import '../../../shared/agent_dm/agent_dm_markers.dart';
import '../../../shared/agent_dm/agent_dm_quiet.dart';
import '../../../shared/relay/nostr_models.dart';
import '../timeline_message.dart';

/// Where a question card stands.
enum AgentDmQuestionStatus {
  /// Waiting for an answer; taps are accepted.
  open,

  /// Answered from this or another of the person's clients.
  answered,

  /// Closed by the agent without an answer.
  closed,
}

/// A sessions listing with the event that carried it.
@immutable
class AgentDmListingEvent {
  /// The listing event's id.
  final String eventId;

  /// The listing event's signer.
  final String signerPubkey;

  /// When the listing was published, in Unix seconds.
  final int createdAt;

  /// The listing.
  final AgentDmSessionsListing listing;

  const AgentDmListingEvent({
    required this.eventId,
    required this.signerPubkey,
    required this.createdAt,
    required this.listing,
  });
}

/// Agent DM markers indexed for one DM's loaded events.
///
/// Built from the raw events (which carry each event's kind), so a marker on
/// the wrong kind, in a non-DM channel, or from a non-member is never
/// honoured. Interactive markers (question cards and action buttons) also
/// need an agent signer other than the reader.
@immutable
class AgentDmTimeline {
  final Set<String> _members;
  final Map<String, String> _signers;
  final Map<String, AgentDmMirror> _mirrors;
  final Map<String, AgentDmSessionDivider> _dividers;
  final Map<String, AgentDmListingEvent> _listings;
  final Set<String> _hidden;
  final Map<String, AgentDmQuestionCard> _questions;
  final Map<String, List<AgentDmAction>> _actions;
  final Map<String, ({int at, AgentDmQuestionStateValue state})> _states;
  final Map<String, Set<String>> _answerSigners;
  final Set<String> _usedActionRefs;

  const AgentDmTimeline._({
    required Set<String> members,
    required Map<String, String> signers,
    required Map<String, AgentDmMirror> mirrors,
    required Map<String, AgentDmSessionDivider> dividers,
    required Map<String, AgentDmListingEvent> listings,
    required Set<String> hidden,
    required Map<String, AgentDmQuestionCard> questions,
    required Map<String, List<AgentDmAction>> actions,
    required Map<String, ({int at, AgentDmQuestionStateValue state})> states,
    required Map<String, Set<String>> answerSigners,
    required Set<String> usedActionRefs,
  }) : _members = members,
       _signers = signers,
       _mirrors = mirrors,
       _dividers = dividers,
       _listings = listings,
       _hidden = hidden,
       _questions = questions,
       _actions = actions,
       _states = states,
       _answerSigners = answerSigners,
       _usedActionRefs = usedActionRefs;

  /// No markers: every event renders as a plain message.
  static const empty = AgentDmTimeline._(
    members: {},
    signers: {},
    mirrors: {},
    dividers: {},
    listings: {},
    hidden: {},
    questions: {},
    actions: {},
    states: {},
    answerSigners: {},
    usedActionRefs: {},
  );

  /// Indexes [events] for a channel. Returns [empty] outside a DM.
  factory AgentDmTimeline.build({
    required Iterable<NostrEvent> events,
    required bool isDm,
    required Iterable<String> memberPubkeys,
    required String? currentPubkey,
    required Set<String> agentPubkeys,
  }) {
    if (!isDm) return empty;
    final members = normalizeAgentDmMembers(memberPubkeys);
    if (members.isEmpty) return empty;
    final self = currentPubkey?.trim().toLowerCase();
    final agents = {for (final pubkey in agentPubkeys) pubkey.toLowerCase()};
    final signers = <String, String>{};
    final mirrors = <String, AgentDmMirror>{};
    final dividers = <String, AgentDmSessionDivider>{};
    final listings = <String, AgentDmListingEvent>{};
    final hidden = <String>{};
    final questions = <String, AgentDmQuestionCard>{};
    final actions = <String, List<AgentDmAction>>{};
    final states = <String, ({int at, AgentDmQuestionStateValue state})>{};
    final answerSigners = <String, Set<String>>{};
    final usedRefs = <String>{};

    for (final event in events) {
      final signer = event.pubkey.trim().toLowerCase();
      if (!members.contains(signer)) continue;
      if (event.kind == agentDmQuietKind) {
        final marker = agentDmQuietMarkerOf(event.kind, event.tags);
        if (marker == null) continue;
        signers[event.id] = signer;
        switch (marker) {
          case AgentDmQuietMarker.mirror:
            mirrors[event.id] = readAgentDmMirror(event.tags)!;
          case AgentDmQuietMarker.sessionDivider:
            dividers[event.id] = readAgentDmSessionDivider(event.tags)!;
          case AgentDmQuietMarker.sessionsListing:
            listings[event.id] = AgentDmListingEvent(
              eventId: event.id,
              signerPubkey: signer,
              createdAt: event.createdAt,
              listing: readAgentDmSessionsListing(event.tags)!,
            );
          case AgentDmQuietMarker.questionState:
            hidden.add(event.id);
            final state = readAgentDmQuestionState(event.tags)!;
            final key = '$signer|${state.askId}';
            final previous = states[key];
            if (previous == null || event.createdAt >= previous.at) {
              states[key] = (at: event.createdAt, state: state.state);
            }
        }
        continue;
      }
      if (event.kind != agentDmReplyKind) continue;
      signers[event.id] = signer;
      final answerAskId = readAgentDmAnswerAskId(event.tags);
      if (answerAskId != null) {
        answerSigners.putIfAbsent(answerAskId, () => {}).add(signer);
      }
      if (signer == self) {
        final ref = readAgentDmActionRef(event.tags);
        if (ref != null) usedRefs.add(ref);
        continue;
      }
      if (!agents.contains(signer)) continue;
      final card = readAgentDmQuestionCard(event.tags);
      if (card != null) questions[event.id] = card;
      final buttons = readAgentDmActions(event.tags);
      if (buttons.isNotEmpty) actions[event.id] = buttons;
    }

    return AgentDmTimeline._(
      members: Set.unmodifiable(members),
      signers: Map.unmodifiable(signers),
      mirrors: Map.unmodifiable(mirrors),
      dividers: Map.unmodifiable(dividers),
      listings: Map.unmodifiable(listings),
      hidden: Set.unmodifiable(hidden),
      questions: Map.unmodifiable(questions),
      actions: Map.unmodifiable(actions),
      states: Map.unmodifiable(states),
      answerSigners: Map.unmodifiable(answerSigners),
      usedActionRefs: Set.unmodifiable(usedRefs),
    );
  }

  /// The mirror marker on message [id], or null.
  AgentDmMirror? mirrorOf(String id) => _mirrors[id];

  /// The session divider on message [id], or null.
  AgentDmSessionDivider? dividerOf(String id) => _dividers[id];

  /// The sessions listing on message [id], or null.
  AgentDmListingEvent? listingOf(String id) => _listings[id];

  /// The question card under message [id], or null.
  AgentDmQuestionCard? questionOf(String id) => _questions[id];

  /// The action buttons under message [id]; empty when none.
  List<AgentDmAction> actionsOf(String id) => _actions[id] ?? const [];

  /// Whether one of message [id]'s actions was already sent by the reader.
  bool actionsUsed(String id) =>
      actionsOf(id).any((action) => _usedActionRefs.contains(action.ref));

  /// Whether message [id] renders no row (question state events).
  bool hidesRow(String id) => _hidden.contains(id);

  /// The status of the question card under message [id].
  ///
  /// An answer from any DM member other than the asking agent wins; then the
  /// asking agent's newest state event decides.
  AgentDmQuestionStatus questionStatusOf(String id) {
    final card = _questions[id];
    final signer = _signers[id];
    if (card == null || signer == null) return AgentDmQuestionStatus.open;
    final answeredBy = _answerSigners[card.askId] ?? const {};
    if (answeredBy.any((pubkey) => pubkey != signer)) {
      return AgentDmQuestionStatus.answered;
    }
    return switch (_states['$signer|${card.askId}']?.state) {
      AgentDmQuestionStateValue.answered => AgentDmQuestionStatus.answered,
      AgentDmQuestionStateValue.closed => AgentDmQuestionStatus.closed,
      null => AgentDmQuestionStatus.open,
    };
  }

  /// The newest sessions listing, optionally only from [signerPubkey].
  AgentDmListingEvent? newestListing({String? signerPubkey}) {
    final signer = signerPubkey?.toLowerCase();
    AgentDmListingEvent? newest;
    for (final listing in _listings.values) {
      if (signer != null && listing.signerPubkey != signer) continue;
      if (newest == null || listing.createdAt > newest.createdAt) {
        newest = listing;
      }
    }
    return newest;
  }

  /// Ids of every loaded listing from [signerPubkey].
  Set<String> listingIdsFrom(String signerPubkey) {
    final signer = signerPubkey.toLowerCase();
    return {
      for (final listing in _listings.values)
        if (listing.signerPubkey == signer) listing.eventId,
    };
  }

  /// The author shown for [message]: a DM member named by a requester
  /// mirror when the rule allows it, otherwise the signer.
  String authorOf(TimelineMessage message) {
    final signer = message.pubkey.toLowerCase();
    return _mirrors[message.id]?.authorOverride(
          signerPubkey: signer,
          memberPubkeys: _members,
        ) ??
        signer;
  }

  /// Whether [message] is a requester mirror shown as "Relayed by" its
  /// signer because its claimed author is not a usable DM member.
  bool isRelayed(TimelineMessage message) {
    final mirror = _mirrors[message.id];
    return mirror != null &&
        mirror.role == AgentDmMirrorRole.requester &&
        authorOf(message) == message.pubkey.toLowerCase();
  }

  /// Drops rows that render nothing and marks dividers and listings as
  /// system rows, so they never group with messages or take read marks.
  List<TimelineMessage> present(List<TimelineMessage> messages) {
    if (_hidden.isEmpty && _dividers.isEmpty && _listings.isEmpty) {
      return messages;
    }
    return [
      for (final message in messages)
        if (!_hidden.contains(message.id))
          _dividers.containsKey(message.id) || _listings.containsKey(message.id)
              ? TimelineMessage(
                  id: message.id,
                  pubkey: message.pubkey,
                  createdAt: message.createdAt,
                  content: message.content,
                  tags: message.tags,
                  isSystem: true,
                  edited: message.edited,
                  reactions: message.reactions,
                  parentId: message.parentId,
                  rootId: message.rootId,
                )
              : message,
    ];
  }
}
