part of 'activity_provider_test.dart';

/// Agent DM markers v1: quiet events never become an inbox mention and never
/// resurface a hidden DM.
void _agentDmQuietActivityCases() {
  const self =
      '1111111111111111111111111111111111111111111111111111111111111111';
  const agent =
      '2222222222222222222222222222222222222222222222222222222222222222';
  const dmId = 'dm-agent';

  NostrEvent quietMirror(String id, {String channelId = dmId}) => NostrEvent(
    id: id,
    pubkey: agent,
    createdAt: 1_700_000_000,
    kind: EventKind.streamMessageV2,
    tags: [
      ['h', channelId],
      // Incorrectly addressed: a quiet marker is still never a mention.
      ['p', self],
      ['buzz-mirror', 'email', 'source-1', '1699999999'],
      ['buzz-mirror-author', 'requester', self, ''],
    ],
    content: 'Mirrored email',
    sig: '',
  );

  NostrEvent reply(String id, {String channelId = dmId}) => NostrEvent(
    id: id,
    pubkey: agent,
    createdAt: 1_700_000_001,
    kind: EventKind.streamMessageV2,
    tags: [
      ['h', channelId],
      ['p', self],
    ],
    content: 'A real reply',
    sig: '',
  );

  ChannelMember member(String pubkey) =>
      ChannelMember(pubkey: pubkey, role: 'member', joinedAt: DateTime(2026));

  test('a quiet agent DM event is never an inbox mention', () async {
    final session = _RecordingSessionNotifier()
      ..seed(quietMirror('quiet-mirror'))
      ..seed(reply('real-reply'));
    final dm = Channel(
      id: dmId,
      name: 'dm',
      channelType: 'dm',
      visibility: 'private',
      description: '',
      createdBy: 'x',
      createdAt: DateTime(2025),
      memberCount: 2,
      isMember: true,
      participantPubkeys: const [self, agent],
    );
    final container = ProviderContainer(
      overrides: [
        relayConfigProvider.overrideWith(_FixedRelayConfigNotifier.new),
        myPubkeyProvider.overrideWithValue(self),
        relaySessionProvider.overrideWith(() => session),
        channelsProvider.overrideWith(() => _FixedChannelsNotifier([dm])),
      ],
    );
    addTearDown(container.dispose);

    await container.read(channelsProvider.future);
    final feed = await container.read(activityProvider.future);
    expect(feed.mentions.map((item) => item.id), ['real-reply']);
  });

  test('a quiet agent DM event never resurfaces a hidden DM', () async {
    final session = _RecordingSessionNotifier();
    final reopened = <List<String>>[];
    final container = ProviderContainer(
      overrides: [
        relayConfigProvider.overrideWith(_FixedRelayConfigNotifier.new),
        myPubkeyProvider.overrideWithValue(self),
        relaySessionProvider.overrideWith(() => session),
        channelsProvider.overrideWith(
          () => _FixedChannelsNotifier(const <Channel>[], hiddenDmIds: {dmId}),
        ),
        channelMembersProvider(
          dmId,
        ).overrideWith((ref) async => [member(self), member(agent)]),
        dmResurfaceActionProvider.overrideWithValue((pubkeys) async {
          reopened.add(pubkeys);
          return dmId;
        }),
      ],
    );
    addTearDown(container.dispose);

    await container.read(channelsProvider.future);
    await container.read(activityProvider.future);
    await _waitFor(() => session.hiddenDmSubscriptionBatches.isNotEmpty);

    session.emit(quietMirror('quiet-hidden'));
    await Future<void>.delayed(const Duration(milliseconds: 50));
    expect(reopened, isEmpty);

    session.emit(reply('real-hidden'));
    await _waitFor(() => reopened.isNotEmpty);
    expect(reopened.single, [agent]);
  });
}
