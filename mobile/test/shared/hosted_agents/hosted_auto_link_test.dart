import 'dart:async';

import 'package:buzz/shared/hosted_agents/hosted_agent_client.dart';
import 'package:buzz/shared/hosted_agents/hosted_agent_config.dart';
import 'package:buzz/shared/hosted_agents/hosted_agent_errors.dart';
import 'package:buzz/shared/hosted_agents/hosted_agent_snapshot.dart';
import 'package:buzz/shared/hosted_agents/hosted_auto_link.dart';
import 'package:buzz/shared/hosted_agents/hosted_owner_attest.dart';
import 'package:buzz/shared/hosted_agents/hosted_owner_rebind.dart';
import 'package:buzz/shared/theme/theme_provider.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:nostr/nostr.dart' as nostr;
import 'package:shared_preferences/shared_preferences.dart';

import 'hosted_agent_fixtures.dart';

const _ownerSecret =
    '1111111111111111111111111111111111111111111111111111111111111111';
final _owner = nostr.Keys(_ownerSecret).public;
final _oldOwner = nostr.Keys('3' * 64).public;

String _key(int fill) => nostr.Keys('${fill % 9 + 1}' * 64).public;

HostedAgentSnapshot _live(String name, {String? owner, int fill = 4}) =>
    HostedAgentSnapshot(
      providerAgentId: 'buzz:$name',
      agentPublicKey: _key(fill),
      displayName: name,
      providerConfig: const {},
      profileRevision: 1,
      desiredState: 'active',
      observedState: 'ready',
      ownerPublicKey: owner ?? _owner,
    );

HostedAgentSnapshot _pending(String name, {int fill = 5}) =>
    HostedAgentSnapshot(
      providerAgentId: 'buzz:$name',
      agentPublicKey: _key(fill),
      displayName: name,
      providerConfig: const {},
      profileRevision: 0,
      desiredState: 'pending_attestation',
      observedState: 'pending_attestation',
      status: hostedAgentStatusPendingAttestation,
    );

class _FakeApi implements HostedAutoLinkApi {
  _FakeApi(this.agents, {this.attest, this.relink, this.listError});

  final List<HostedAgentSnapshot> agents;
  final HostedAttestOutcome Function(HostedAgentSnapshot)? attest;
  final HostedRebindOutcome Function(HostedAgentSnapshot)? relink;
  final HostedAgentException? listError;
  HostedAgentException? attestError;

  final attested = <List<String>>[];
  final rebound = <List<String>>[];

  @override
  Future<List<HostedAgentSnapshot>> list() async {
    if (listError case final error?) throw error;
    return agents;
  }

  @override
  Future<List<HostedAttestOutcome>> attestPending(
    List<HostedAgentSnapshot> batch,
  ) async {
    attested.add([for (final agent in batch) agent.displayName]);
    if (attestError case final error?) throw error;
    return [
      for (final agent in batch)
        attest?.call(agent) ??
            HostedAttestOutcome(
              providerAgentId: agent.providerAgentId,
              status: HostedAttestStatus.activated,
              dmOpened: true,
            ),
    ];
  }

  @override
  Future<List<HostedRebindOutcome>> rebind(
    List<HostedAgentSnapshot> batch,
  ) async {
    rebound.add([for (final agent in batch) agent.displayName]);
    return [
      for (final agent in batch)
        relink?.call(agent) ??
            HostedRebindOutcome(
              providerAgentId: agent.providerAgentId,
              status: HostedRebindStatus.rebound,
            ),
    ];
  }
}

HostedAttestOutcome _attestRejected(HostedAgentSnapshot agent, String code) =>
    HostedAttestOutcome(
      providerAgentId: agent.providerAgentId,
      status: HostedAttestStatus.rejected,
      code: code,
    );

HostedRebindOutcome _rebindRejected(HostedAgentSnapshot agent, String code) =>
    HostedRebindOutcome(
      providerAgentId: agent.providerAgentId,
      status: HostedRebindStatus.rejected,
      code: code,
    );

void main() {
  group('pass', () {
    test(
      'attests pending agents, re-links stale ones, and names them',
      () async {
        final api = _FakeApi([
          _pending('scout'),
          _live('Ada', owner: _oldOwner, fill: 6),
          _live('Mira', fill: 7),
          _pending('Mail Helper', fill: 8),
        ]);
        final result = await runHostedAutoLinkPass(
          api: api,
          ownerPublicKey: _owner,
          memory: HostedAutoLinkMemory(),
        );
        expect(api.attested, [
          ['scout', 'Mail Helper'],
        ]);
        expect(api.rebound, [
          ['Ada'],
        ]);
        expect(result.linked, ['scout', 'Ada', 'Mail Helper']);
        expect(result.sent, isTrue);
        expect(
          hostedAutoLinkNote(result.linked),
          'Linked: scout, Ada, Mail Helper',
        );
      },
    );

    test('sends at most 20 agents per request', () async {
      final api = _FakeApi([
        for (var index = 0; index < 45; index++) _pending('p$index'),
      ]);
      final result = await runHostedAutoLinkPass(
        api: api,
        ownerPublicKey: _owner,
        memory: HostedAutoLinkMemory(),
      );
      expect(api.attested.map((batch) => batch.length), [20, 20, 5]);
      expect(result.linked, hasLength(45));
    });

    test('nothing to do sends nothing and says nothing', () async {
      final api = _FakeApi([_live('Mira')]);
      final result = await runHostedAutoLinkPass(
        api: api,
        ownerPublicKey: _owner,
        memory: HostedAutoLinkMemory(),
      );
      expect(api.attested, isEmpty);
      expect(api.rebound, isEmpty);
      expect(result.sent, isFalse);
      expect(hostedAutoLinkNote(result.linked), isNull);
    });

    test(
      'permanent refusals are not signed again; retryable ones are',
      () async {
        final api = _FakeApi(
          [
            _pending('scout'),
            _pending('theirs', fill: 6),
            _live('Ada', owner: _oldOwner, fill: 7),
            _live('Sage', owner: _oldOwner, fill: 8),
          ],
          attest: (agent) => _attestRejected(
            agent,
            agent.displayName == 'theirs'
                ? 'not_agent_owner'
                : 'activate_failed',
          ),
          relink: (agent) => _rebindRejected(
            agent,
            agent.displayName == 'Ada'
                ? 'previous_owner_not_revoked'
                : 'rebind_failed',
          ),
        );
        final memory = HostedAutoLinkMemory();
        final first = await runHostedAutoLinkPass(
          api: api,
          ownerPublicKey: _owner,
          memory: memory,
        );
        expect(first.linked, isEmpty);
        await runHostedAutoLinkPass(
          api: api,
          ownerPublicKey: _owner,
          memory: memory,
        );
        expect(api.attested, [
          ['scout', 'theirs'],
          ['scout'],
        ]);
        expect(api.rebound, [
          ['Ada', 'Sage'],
          ['Sage'],
        ]);
      },
    );

    test(
      'a DM that failed to open is linked; already active is not named',
      () async {
        final dmFailed = _FakeApi([
          _pending('scout'),
        ], attest: (agent) => _attestRejected(agent, 'dm_open_failed'));
        final memory = HostedAutoLinkMemory();
        expect(
          (await runHostedAutoLinkPass(
            api: dmFailed,
            ownerPublicKey: _owner,
            memory: memory,
          )).linked,
          ['scout'],
        );
        final already = _FakeApi(
          [_pending('scout')],
          attest: (agent) => HostedAttestOutcome(
            providerAgentId: agent.providerAgentId,
            status: HostedAttestStatus.alreadyActive,
          ),
        );
        expect(
          (await runHostedAutoLinkPass(
            api: already,
            ownerPublicKey: _owner,
            memory: HostedAutoLinkMemory(),
          )).linked,
          isEmpty,
        );
      },
    );

    test(
      'a whole-request failure stops the pass and reports its code',
      () async {
        final api =
            _FakeApi([
                _pending('scout'),
                _live('Ada', owner: _oldOwner, fill: 6),
              ])
              ..attestError = const HostedAgentException(
                'buzz_hosted_owner_proof_invalid',
              );
        final result = await runHostedAutoLinkPass(
          api: api,
          ownerPublicKey: _owner,
          memory: HostedAutoLinkMemory(),
        );
        expect(result.errors, ['buzz_hosted_owner_proof_invalid']);
        expect(api.rebound, isEmpty);

        final offline = _FakeApi(
          const [],
          listError: const HostedAgentException('hosted_agents_unreachable'),
        );
        final listed = await runHostedAutoLinkPass(
          api: offline,
          ownerPublicKey: _owner,
          memory: HostedAutoLinkMemory(),
        );
        expect(listed.errors, ['hosted_agents_unreachable']);
        expect(listed.sent, isFalse);
      },
    );

    test('the note is short and quiet', () {
      expect(hostedAutoLinkNote(const []), isNull);
      expect(hostedAutoLinkNote(const ['scout']), 'Linked: scout');
      expect(
        hostedAutoLinkNote(const ['a', 'b', 'c', 'd', 'e', 'f']),
        'Linked: a, b, c and 3 more',
      );
    });
  });

  group('scheduler', () {
    test('runs on launch, on resume after a minute, and on the 15-minute '
        'tick only in the foreground, never two at once', () async {
      var now = DateTime(2026, 10, 22, 9);
      var foreground = true;
      var runs = 0;
      var pass = Completer<void>();
      final scheduler = HostedAutoLinkScheduler(
        isForeground: () => foreground,
        now: () => now,
        runPass: () {
          runs++;
          pass = Completer<void>();
          return pass.future;
        },
      );
      Future<void> finish() async {
        pass.complete();
        await Future<void>.delayed(Duration.zero);
      }

      expect(scheduler.trigger(HostedAutoLinkTrigger.launch), isTrue);
      now = now.add(hostedAutoLinkResumeGap);
      // Never two at once.
      expect(scheduler.trigger(HostedAutoLinkTrigger.resume), isFalse);
      await finish();
      now = now.subtract(const Duration(seconds: 1));
      expect(scheduler.trigger(HostedAutoLinkTrigger.resume), isFalse);
      now = now.add(const Duration(seconds: 1));
      expect(scheduler.trigger(HostedAutoLinkTrigger.resume), isTrue);
      await finish();
      now = now.add(hostedAutoLinkInterval);
      foreground = false;
      expect(scheduler.trigger(HostedAutoLinkTrigger.interval), isFalse);
      foreground = true;
      expect(scheduler.trigger(HostedAutoLinkTrigger.interval), isTrue);
      await finish();
      expect(runs, 3);
      scheduler.stop();
      now = now.add(hostedAutoLinkInterval);
      expect(scheduler.trigger(HostedAutoLinkTrigger.launch), isFalse);
    });

    test('a failing pass does not stop later passes', () async {
      var now = DateTime(2026, 10, 22, 9);
      var runs = 0;
      final scheduler = HostedAutoLinkScheduler(
        isForeground: () => true,
        now: () => now,
        runPass: () async {
          runs++;
          throw StateError('offline');
        },
      );
      expect(scheduler.trigger(HostedAutoLinkTrigger.launch), isTrue);
      await Future<void>.delayed(Duration.zero);
      now = now.add(hostedAutoLinkResumeGap);
      expect(scheduler.trigger(HostedAutoLinkTrigger.resume), isTrue);
      await Future<void>.delayed(Duration.zero);
      expect(runs, 2);
    });
  });

  group('setting', () {
    test(
      'is off by default, per signed-in key, and removed when off',
      () async {
        SharedPreferences.setMockInitialValues({});
        final prefs = await SharedPreferences.getInstance();
        HostedAgentClient client(String secret) => HostedAgentClient(
          route: const HostedAgentRoute(
            baseUrl: fixtureApiBase,
            catalogKey: 'k',
            executionLocation: 'example-compute',
            communityId: 'chat.example.test',
            relayUrl: 'wss://chat.example.test',
            relayHttpUrl: 'https://chat.example.test',
          ),
          ownerNsec: nostr.Keys(secret).nsec,
        );
        ProviderContainer container(String secret) => ProviderContainer(
          overrides: [
            savedPrefsProvider.overrideWithValue(prefs),
            hostedAgentClientProvider.overrideWithValue(client(secret)),
          ],
        );

        final mine = container(_ownerSecret);
        addTearDown(mine.dispose);
        expect(mine.read(hostedAutoLinkSettingProvider), isFalse);
        await mine.read(hostedAutoLinkSettingProvider.notifier).set(true);
        expect(mine.read(hostedAutoLinkSettingProvider), isTrue);
        expect(prefs.getBool(hostedAutoLinkSettingKey(_owner)!), isTrue);

        final other = container('3' * 64);
        addTearDown(other.dispose);
        expect(other.read(hostedAutoLinkSettingProvider), isFalse);

        await mine.read(hostedAutoLinkSettingProvider.notifier).set(false);
        expect(prefs.getKeys(), isEmpty);
        expect(hostedAutoLinkSettingKey('not-a-key'), isNull);

        final none = ProviderContainer(
          overrides: [
            savedPrefsProvider.overrideWithValue(prefs),
            hostedAgentClientProvider.overrideWithValue(null),
          ],
        );
        addTearDown(none.dispose);
        expect(none.read(hostedAutoLinkSettingProvider), isFalse);
        await none.read(hostedAutoLinkSettingProvider.notifier).set(true);
        expect(prefs.getKeys(), isEmpty);
      },
    );
  });
}
