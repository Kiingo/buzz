import 'package:buzz/shared/relay/media_auth.dart';
import 'package:buzz/shared/relay/media_image.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:nostr/nostr.dart' as nostr;

const _relayBase = 'https://relay.example.com';
const _mediaUrl = '$_relayBase/media/abc123.png';

MediaImageProvider _image(MediaGetAuthService auth, http.Client client) =>
    MediaImageProvider(url: _mediaUrl, auth: auth, client: client);

void main() {
  late http.Client client;

  setUp(() => client = http.Client());
  tearDown(() => client.close());

  test('rebuilt auth service for the same relay and key => equal keys', () {
    final nsec = nostr.Keys.generate().nsec;
    final a = _image(
      MediaGetAuthService(baseUrl: _relayBase, nsec: nsec),
      client,
    );
    final b = _image(
      MediaGetAuthService(baseUrl: _relayBase, nsec: nsec),
      client,
    );
    expect(a, equals(b));
    expect(a.hashCode, equals(b.hashCode));
  });

  test('same key on a different relay => unequal keys', () {
    final nsec = nostr.Keys.generate().nsec;
    final a = _image(
      MediaGetAuthService(baseUrl: _relayBase, nsec: nsec),
      client,
    );
    final b = _image(
      MediaGetAuthService(baseUrl: 'https://other.example.com', nsec: nsec),
      client,
    );
    expect(a, isNot(equals(b)));
  });

  test('different account on the same relay => unequal keys', () {
    final a = _image(
      MediaGetAuthService(
        baseUrl: _relayBase,
        nsec: nostr.Keys.generate().nsec,
      ),
      client,
    );
    final b = _image(
      MediaGetAuthService(
        baseUrl: _relayBase,
        nsec: nostr.Keys.generate().nsec,
      ),
      client,
    );
    expect(a, isNot(equals(b)));
  });

  test('cache scope carries the public key, never the secret', () {
    final keys = nostr.Keys.generate();
    final scope = MediaGetAuthService(
      baseUrl: _relayBase,
      nsec: keys.nsec,
    ).cacheScope;
    expect(scope, contains(keys.public));
    expect(scope, isNot(contains(keys.nsec)));
    expect(scope, isNot(contains(keys.secret)));
  });
}
