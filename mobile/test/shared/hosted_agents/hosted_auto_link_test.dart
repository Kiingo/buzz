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
        final scout = _pending('scout');
        final ada = _live('Ada', owner: _oldOwner, fill: 6);
        final helper = _pending('Mail Helper', fill: 8);
        final api = _FakeApi([scout, ada, _live('Mira', fill: 7), helper]);
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
        // Each agent is named with its key fingerprint.
        final names = [
          for (final agent in [scout, ada, helper]) agent.fingerprintedName,
        ];
        expect(result.linked, names);
        expect(names.first, 'scout (${scout.agentPublicKey.substring(0, 8)})');
        expect(result.sent, isTrue);
        expect(result.cancelled, isFalse);
        expect(
          hostedAutoLinkNote(result.linked),
          'Linked: ${names.join(', ')}',
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
        // Permanent refusals are named once, with the reason; retryable
        // ones are not.
        expect(first.notLinked.map((agent) => agent.name), [
          _pending('theirs', fill: 6).fingerprintedName,
          _live('Ada', owner: _oldOwner, fill: 7).fingerprintedName,
        ]);
        expect(first.notLinked.map((agent) => agent.reason), [
          describeAttestRejection('not_agent_owner'),
          describeRebindRejection('previous_owner_not_revoked'),
        ]);
        final note = hostedAutoLinkRefusedNote(first.notLinked)!;
        expect(note.split('\n').first, "Couldn't link 2 agents");
        final second = await runHostedAutoLinkPass(
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
        expect(second.notLinked, isEmpty);
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
          [_pending('scout').fingerprintedName],
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

  group('names', () {
    test(
      'a bad name never drops an agent; it is cleaned or replaced',
      () async {
        expect(hostedAgentPrintableName(' Ada\u202E\u0007 '), 'Ada');
        expect(
          hostedAgentPrintableName('Ada\nLinked: Mira'),
          'Ada Linked: Mira',
        );
        expect(hostedAgentPrintableName('   '), isEmpty);
        expect(hostedAgentPrintableName('x' * 300).length, 200);

        final nameless = HostedAgentSnapshot(
          providerAgentId: 'buzz:ghost',
          agentPublicKey: _key(5),
          displayName: '\u202E\u0000',
          providerConfig: const {},
          profileRevision: 0,
          desiredState: 'pending_attestation',
          observedState: 'pending_attestation',
          status: hostedAgentStatusPendingAttestation,
        );
        expect(nameless.printableName, 'Unnamed agent');
        expect(
          nameless.fingerprintedName,
          'Unnamed agent (${nameless.agentPublicKey.substring(0, 8)})',
        );
        // Still linked, under the fallback name.
        final api = _FakeApi([nameless]);
        final result = await runHostedAutoLinkPass(
          api: api,
          ownerPublicKey: _owner,
          memory: HostedAutoLinkMemory(),
        );
        expect(api.attested, [
          ['\u202E\u0000'],
        ]);
        expect(result.linked, [nameless.fingerprintedName]);
      },
    );

    test('the refused note never carries control characters', () {
      final note = hostedAutoLinkRefusedNote(const [
        HostedAutoLinkRefusal(name: 'Ada\nLinked: Mira\u202E', reason: 'No.'),
        HostedAutoLinkRefusal(name: '\u0007', reason: 'No.'),
      ])!;
      final lines = note.split('\n');
      expect(lines, [
        "Couldn't link 2 agents",
        'Ada Linked: Mira: No.',
        'An agent: No.',
      ]);
      expect(note.contains('\u202E'), isFalse);
      expect(note.contains('\u0007'), isFalse);
    });
  });

  group('cancellation', () {
    test(
      'turning the setting off stops a pass before its next request',
      () async {
        // Off before the first request: the list is read, nothing is signed.
        final off = _FakeApi([
          _pending('scout'),
          _live('Ada', owner: _oldOwner, fill: 6),
        ]);
        final stopped = await runHostedAutoLinkPass(
          api: off,
          ownerPublicKey: _owner,
          memory: HostedAutoLinkMemory(),
          shouldContinue: () => false,
        );
        expect(off.attested, isEmpty);
        expect(off.rebound, isEmpty);
        expect(stopped.cancelled, isTrue);
        expect(stopped.sent, isFalse);

        // Off between batches: the batch in flight finishes, no later one
        // starts, and what it linked is still reported.
        var enabled = true;
        final midway = _FakeApi(
          [
            for (var index = 0; index < 45; index++) _pending('p$index'),
            _live('Ada', owner: _oldOwner, fill: 6),
          ],
          attest: (agent) {
            enabled = false;
            return HostedAttestOutcome(
              providerAgentId: agent.providerAgentId,
              status: HostedAttestStatus.activated,
              dmOpened: true,
            );
          },
        );
        final partial = await runHostedAutoLinkPass(
          api: midway,
          ownerPublicKey: _owner,
          memory: HostedAutoLinkMemory(),
          shouldContinue: () => enabled,
        );
        expect(midway.attested.map((batch) => batch.length), [20]);
        expect(midway.rebound, isEmpty);
        expect(partial.cancelled, isTrue);
        expect(partial.linked, hasLength(20));
      },
    );

    test('switching keys mid-pass stops it the same way', () async {
      var signedIn = _owner;
      final api = _FakeApi(
        [_pending('scout'), _live('Ada', owner: _oldOwner, fill: 6)],
        attest: (agent) {
          signedIn = _oldOwner;
          return HostedAttestOutcome(
            providerAgentId: agent.providerAgentId,
            status: HostedAttestStatus.activated,
            dmOpened: true,
          );
        },
      );
      final result = await runHostedAutoLinkPass(
        api: api,
        ownerPublicKey: _owner,
        memory: HostedAutoLinkMemory(),
        shouldContinue: () => signedIn == _owner,
      );
      expect(api.attested, [
        ['scout'],
      ]);
      expect(api.rebound, isEmpty);
      expect(result.cancelled, isTrue);
    });
  });

  group('backoff', () {
    const failed = HostedAutoLinkResult(errors: ['hosted_agents_unreachable']);
    const ok = HostedAutoLinkResult();

    test('whole-request failures back off and say so once', () {
      final backoff = HostedAutoLinkBackoff();
      var now = DateTime(2026, 10, 22, 9);
      // The first failures stay quiet and do not delay the next pass.
      for (
        var index = 1;
        index < hostedAutoLinkFailuresBeforeBackoff;
        index++
      ) {
        expect(backoff.record(failed, now), isNull);
        expect(backoff.allows(now), isTrue);
      }
      // Then one plain note, and the next pass waits.
      final note = backoff.record(failed, now);
      expect(note, startsWith("Couldn't link your agents automatically."));
      expect(
        backoff.allows(
          now.add(hostedAutoLinkBackoffBase - const Duration(seconds: 1)),
        ),
        isFalse,
      );
      expect(backoff.allows(now.add(hostedAutoLinkBackoffBase)), isTrue);
      // Each further failure doubles the wait, silently, up to the cap.
      now = now.add(hostedAutoLinkBackoffBase);
      expect(backoff.record(failed, now), isNull);
      expect(
        backoff.allows(
          now.add(hostedAutoLinkBackoffBase * 2 - const Duration(seconds: 1)),
        ),
        isFalse,
      );
      expect(backoff.allows(now.add(hostedAutoLinkBackoffBase * 2)), isTrue);
      for (var index = 0; index < 40; index++) {
        backoff.record(failed, now);
      }
      expect(
        backoff.allows(
          now.add(hostedAutoLinkBackoffMax - const Duration(seconds: 1)),
        ),
        isFalse,
      );
      expect(backoff.allows(now.add(hostedAutoLinkBackoffMax)), isTrue);
      // A cancelled pass changes nothing.
      final before = backoff.failures;
      expect(
        backoff.record(const HostedAutoLinkResult(cancelled: true), now),
        isNull,
      );
      expect(backoff.failures, before);
      // A pass that gets through resets it; a new run says so again.
      expect(backoff.record(ok, now), isNull);
      expect(backoff.failures, 0);
      expect(backoff.allows(now), isTrue);
      for (
        var index = 1;
        index < hostedAutoLinkFailuresBeforeBackoff;
        index++
      ) {
        backoff.record(failed, now);
      }
      expect(backoff.record(failed, now), isNotNull);
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
