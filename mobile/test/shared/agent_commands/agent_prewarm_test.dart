import 'package:buzz/shared/agent_commands/agent_prewarm.dart';
import 'package:buzz/shared/guest_access/guest_access_client.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:nostr/nostr.dart' as nostr;

void main() {
  test('POSTs a NIP-98-signed empty prewarm for the agent', () async {
    final keys = nostr.Keys.generate();
    http.BaseRequest? sent;
    final client = MockClient((request) async {
      sent = request;
      return http.Response('{"outcome":"noop"}', 200);
    });
    await requestAgentDmPrewarm(
      route: const GuestAccessRoute(
        baseUrl: 'https://api.example.com/v1',
        communityId: 'chat.example.com',
      ),
      nsec: keys.nsec,
      agentPublicKey: 'a' * 64,
      httpClient: client,
    );
    expect(sent!.method, 'POST');
    expect(
      sent!.url.toString(),
      'https://api.example.com/v1/agents/${'a' * 64}/prewarm',
    );
    expect(sent!.headers['Authorization'], startsWith('Nostr '));
    expect(sent!.headers['X-Buzz-Community'], 'chat.example.com');
    expect((sent! as http.Request).bodyBytes, isEmpty);
  });
}
