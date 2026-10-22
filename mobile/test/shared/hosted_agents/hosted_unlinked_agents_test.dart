import 'dart:convert';

import 'package:buzz/shared/hosted_agents/hosted_agent_client.dart';
import 'package:buzz/shared/hosted_agents/hosted_agent_config.dart';
import 'package:buzz/shared/hosted_agents/hosted_agent_errors.dart';
import 'package:buzz/shared/hosted_agents/hosted_unlinked_agents.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:nostr/nostr.dart' as nostr;

import 'hosted_agent_fixtures.dart';

const _ownerSecret =
    '1111111111111111111111111111111111111111111111111111111111111111';
const _scout = '0a1b2c3d-0000-4000-8000-00000000abcd';
const _helper = '0a1b2c3d-0000-4000-8000-00000000abce';

HostedAgentClient _client(http.Client http) => HostedAgentClient(
  route: const HostedAgentRoute(
    baseUrl: fixtureApiBase,
    catalogKey: 'k',
    executionLocation: 'example-compute',
    communityId: 'chat.example.test',
    relayUrl: 'wss://chat.example.test',
    relayHttpUrl: 'https://chat.example.test',
  ),
  ownerNsec: nostr.Keys(_ownerSecret).nsec,
  httpClient: http,
);

Map<String, Object?> _entry(
  Object? id,
  Object? name, {
  Object? principal = 'User',
  Object? machineDefault = false,
}) => {
  'kiingo_agent_id': id,
  'display_name': name,
  'owner_principal_type': principal,
  'machine_default': machineDefault,
};

void main() {
  final catalog = fixtureCatalog(List.filled(32, 7));

  test(
    'lists with a read-only list_unlinked proof and parses the answer',
    () async {
      late Uri url;
      late Map<String, Object?> sent;
      final client = _client(
        MockClient((request) async {
          url = request.url;
          sent = jsonDecode(request.body) as Map<String, Object?>;
          return http.Response(
            jsonEncode({
              'contract_version': 1,
              'correlation_id': sent['request_id'],
              'agents': [
                _entry(_scout.toUpperCase(), ' Scout '),
                _entry(_helper, 'Mail Helper', principal: 'Organization'),
              ],
            }),
            200,
          );
        }),
      );
      final agents = await client.listUnlinked(catalog: catalog);

      expect(url.path, endsWith('/owner/agents/unlinked'));
      expect(sent.keys.toSet(), {
        'contract_version',
        'request_id',
        'owner_proof',
      });
      final proof = sent['owner_proof']! as Map<String, Object?>;
      final tags = (proof['tags']! as List).cast<List>();
      expect(tags.map((tag) => tag.first), [
        'action',
        'provider',
        'request',
        'community',
        'expires',
      ]);
      expect(tags.first, ['action', 'list_unlinked']);
      expect(tags[2], ['request', sent['request_id']]);
      expect(tags[3], ['community', 'chat.example.test']);

      expect(agents.map((agent) => agent.kiingoAgentId), [_scout, _helper]);
      expect(agents.first.displayName, 'Scout');
      expect(agents.first.organizationOwned, isFalse);
      expect(agents.last.organizationOwned, isTrue);
    },
  );

  test('machine defaults, malformed entries and repeats are left out', () {
    final agents = parseHostedUnlinkedAgents({
      'contract_version': 1,
      'correlation_id': 'r',
      'agents': [
        _entry(_scout, 'Scout'),
        _entry(_helper, 'This Mac', machineDefault: true),
        _entry(_helper, 'No flag', machineDefault: null),
        _entry('not-a-uuid', 'Bad id'),
        _entry(_helper, '   '),
        _entry(_helper, 'Team', principal: 'Group'),
        _entry(_scout, 'Scout again'),
        'not an object',
        _entry(_helper, 'Mail Helper'),
      ],
    }, 'r');
    expect(agents.map((agent) => agent.displayName), ['Scout', 'Mail Helper']);
  });

  test('an answer for another request or contract is refused', () {
    for (final body in <Object?>[
      {'contract_version': 1, 'correlation_id': 'other', 'agents': []},
      {'contract_version': 2, 'correlation_id': 'r', 'agents': []},
      {'contract_version': 1, 'correlation_id': 'r'},
      null,
    ]) {
      expect(
        () => parseHostedUnlinkedAgents(body, 'r'),
        throwsA(
          isA<HostedAgentException>().having(
            (error) => error.code,
            'code',
            'response_invalid',
          ),
        ),
      );
    }
  });

  test('attach failures use this app\'s words, with or without the prefix', () {
    for (final code in [
      'buzz_hosted_already_has_buzz_identity',
      'already_has_buzz_identity',
      'buzz_hosted_not_agent_owner',
      'buzz_hosted_agent_spec_required',
      'kiingo_agent_id_invalid',
      'buzz_hosted_provisioning_keys_unconfigured',
      'buzz_hosted_scope_unconfigured',
    ]) {
      final error = HostedAgentException(
        code,
        status: 409,
        serverMessage: 'raw server text',
      );
      expect(error.message, isNot('raw server text'), reason: code);
      expect(error.message, isNot(contains('_')), reason: code);
    }
    // Other codes still prefer the API's own words.
    expect(
      const HostedAgentException(
        'provisioning_failed',
        serverMessage: 'raw server text',
      ).message,
      'raw server text',
    );
  });
}
