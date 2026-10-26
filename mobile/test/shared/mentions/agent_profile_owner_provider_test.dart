import 'dart:convert';
import 'dart:typed_data';

import 'package:buzz/shared/mentions/agent_identity_provider.dart';
import 'package:buzz/shared/relay/relay.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:nostr/nostr.dart' as nostr;
import 'package:pointycastle/digests/sha256.dart';

void main() {
  final owner = nostr.Keys.generate();
  final agent = nostr.Keys.generate();

  NostrEvent profile(int createdAt, {bool attested = true}) {
    final message = _sha256Hex('nostr:agent-auth:${agent.public}:');
    final sig = nostr.Schnorr.sign(secretKey: owner.secret, message: message);
    return NostrEvent.fromJson(
      nostr.Event.from(
        kind: 0,
        content: '{}',
        secretKey: agent.secret,
        createdAt: createdAt,
        tags: [
          if (attested) ['auth', owner.public, '', sig],
        ],
      ).toMap(),
    );
  }

  ({ProviderContainer container, _ProfileRelaySession relay}) setUpOwner(
    NostrEvent first,
  ) {
    final relay = _ProfileRelaySession(first);
    final container = ProviderContainer(
      overrides: [relaySessionProvider.overrideWith(() => relay)],
    );
    addTearDown(container.dispose);
    final keepAlive = container.listen(
      agentProfileOwnerProvider(agent.public),
      (_, _) {},
      fireImmediately: true,
    );
    addTearDown(keepAlive.close);
    return (container: container, relay: relay);
  }

  Future<String?> ownerOf(ProviderContainer container) async {
    await _pumpEventQueue();
    return container.read(agentProfileOwnerProvider(agent.public).future);
  }

  test('a newer profile without the attestation revokes the owner', () async {
    final (:container, :relay) = setUpOwner(profile(100));
    expect(await ownerOf(container), owner.public);
    expect(relay.liveFilters.single.authors, [agent.public]);

    relay.newest = profile(200, attested: false);
    relay.emit(relay.newest);
    expect(await ownerOf(container), isNull);
  });

  test('no owner while the live profile subscription is down', () async {
    final (:container, :relay) = setUpOwner(profile(100));
    expect(await ownerOf(container), owner.public);

    relay.setStatus(RelaySubscriptionStatus.retrying);
    expect(await ownerOf(container), isNull);

    relay.setStatus(RelaySubscriptionStatus.ready);
    expect(await ownerOf(container), owner.public);
  });
}

String _sha256Hex(String input) {
  final digest = SHA256Digest().process(Uint8List.fromList(utf8.encode(input)));
  return digest.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
}

Future<void> _pumpEventQueue() async {
  for (var i = 0; i < 4; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

class _ProfileRelaySession extends RelaySessionNotifier {
  NostrEvent newest;
  final List<NostrFilter> liveFilters = [];
  final List<
    ({
      void Function(NostrEvent) onEvent,
      void Function(RelaySubscriptionStatus) onStatusChanged,
    })
  >
  _subscriptions = [];

  _ProfileRelaySession(this.newest);

  @override
  SessionState build() => const SessionState(status: SessionStatus.connected);

  @override
  Future<List<NostrEvent>> fetchHistory(
    NostrFilter filter, {
    Duration timeout = const Duration(seconds: 8),
  }) async => [newest];

  @override
  Future<void Function()> subscribeWithStatus(
    NostrFilter filter,
    void Function(NostrEvent) onEvent, {
    void Function(String message)? onClosed,
    required void Function(RelaySubscriptionStatus status) onStatusChanged,
  }) async {
    liveFilters.add(filter);
    final subscription = (onEvent: onEvent, onStatusChanged: onStatusChanged);
    _subscriptions.add(subscription);
    onStatusChanged(RelaySubscriptionStatus.ready);
    return () => _subscriptions.remove(subscription);
  }

  void emit(NostrEvent event) {
    for (final subscription in List.of(_subscriptions)) {
      subscription.onEvent(event);
    }
  }

  void setStatus(RelaySubscriptionStatus status) {
    for (final subscription in List.of(_subscriptions)) {
      subscription.onStatusChanged(status);
    }
  }
}
