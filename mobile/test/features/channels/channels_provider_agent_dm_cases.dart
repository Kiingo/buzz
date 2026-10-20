part of 'channels_provider_test.dart';

/// Agent DM markers v1: quiet events never reach the observed unread state
/// that the channel list, unread badge and Me unread all read.
void _agentDmQuietCases() {
  const myPk = 'me';
  const agentPk =
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const strangerPk =
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  NostrEvent dmMeta(String id) => NostrEvent(
    id: 'meta-$id',
    pubkey: 'creator',
    createdAt: 1,
    kind: 39000,
    tags: [
      ['d', id],
      ['name', 'DM'],
      ['t', 'dm'],
      ['private'],
      ['p', myPk],
      ['p', agentPk],
    ],
    content: '',
    sig: 'sig',
  );

  NostrEvent mirror(
    String id,
    String channelId,
    int createdAt, {
    String signer = agentPk,
  }) => NostrEvent(
    id: id,
    pubkey: signer,
    createdAt: createdAt,
    kind: EventKind.streamMessageV2,
    tags: [
      ['h', channelId],
      ['buzz-mirror', 'email', 'msg-1', '1700000000'],
      ['buzz-mirror-author', 'requester', '', 'Ross'],
    ],
    content: 'Mirrored email',
    sig: 'sig',
  );

  NostrEvent divider(String id, String channelId, int createdAt) => NostrEvent(
    id: id,
    pubkey: agentPk,
    createdAt: createdAt,
    kind: EventKind.streamMessageV2,
    tags: [
      ['h', channelId],
      ['buzz-session', 'new', ''],
    ],
    content: 'Started a new session.',
    sig: 'sig',
  );

  NostrEvent plain(String id, String channelId, int createdAt) => NostrEvent(
    id: id,
    pubkey: agentPk,
    createdAt: createdAt,
    kind: EventKind.streamMessage,
    tags: [
      ['h', channelId],
    ],
    content: 'A real reply',
    sig: 'sig',
  );

  test('live quiet agent DM events never become unread', () async {
    final session = _FakeRelaySession(
      memberships: [_membership(_channelD, myPk, additionalPubkey: agentPk)],
      metadata: [dmMeta(_channelD)],
    );
    final container = _buildContainer(session: session);
    addTearDown(container.dispose);
    await container.read(channelsProvider.future);
    await _waitUntil(() => session.activeChannels.isNotEmpty);

    session.emit(mirror('mirror-1', _channelD, 40));
    session.emit(divider('divider-1', _channelD, 41));
    await _settle();
    final notifier = container.read(channelsProvider.notifier);
    expect(notifier.observedUnreadEventsByChannel[_channelD], isNull);
    expect(notifier.latestObservedByChannel, isNot(contains(_channelD)));

    session.emit(plain('reply-1', _channelD, 42));
    await _settle();
    expect(notifier.observedUnreadEventsByChannel[_channelD]?.keys, [
      'reply-1',
    ]);
  });

  test(
    'a mirror signed by a non-member stays an ordinary unread message',
    () async {
      final session = _FakeRelaySession(
        memberships: [_membership(_channelD, myPk, additionalPubkey: agentPk)],
        metadata: [dmMeta(_channelD)],
      );
      final container = _buildContainer(session: session);
      addTearDown(container.dispose);
      await container.read(channelsProvider.future);
      await _waitUntil(() => session.activeChannels.isNotEmpty);

      session.emit(mirror('mirror-x', _channelD, 40, signer: strangerPk));
      await _settle();
      expect(
        container
            .read(channelsProvider.notifier)
            .observedUnreadEventsByChannel[_channelD]
            ?.keys,
        ['mirror-x'],
      );
    },
  );

  test('a mirror outside a DM is not quiet', () async {
    final session = _FakeRelaySession(
      memberships: [_membership(_channelA, myPk)],
      metadata: [_meta(id: _channelA, name: 'general')],
    );
    final container = _buildContainer(session: session);
    addTearDown(container.dispose);
    await container.read(channelsProvider.future);
    await _waitUntil(() => session.activeChannels.isNotEmpty);

    // Stream channels count ordinary top-level messages without a mention.
    session.emit(mirror('mirror-stream', _channelA, 40));
    await _settle();
    expect(
      container
          .read(channelsProvider.notifier)
          .observedUnreadEventsByChannel[_channelA]
          ?.keys,
      ['mirror-stream'],
    );
  });

  test('unread catch-up skips quiet agent DM events', () async {
    final session = _FakeRelaySession(
      memberships: [_membership(_channelD, myPk, additionalPubkey: agentPk)],
      metadata: [dmMeta(_channelD)],
      recentMessages: [
        mirror('mirror-2', _channelD, 50),
        plain('reply-2', _channelD, 51),
      ],
    );
    final container = _buildContainer(session: session);
    addTearDown(container.dispose);
    await container.read(channelsProvider.future);
    final notifier = container.read(channelsProvider.notifier);
    await notifier.waitForUnreadCatchUp();
    await _settle();
    expect(notifier.observedUnreadEventsByChannel[_channelD]?.keys, [
      'reply-2',
    ]);
  });
}
