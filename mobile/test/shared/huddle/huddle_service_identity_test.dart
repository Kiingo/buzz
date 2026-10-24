import 'package:buzz/shared/huddle/huddle_service_identity.dart';
import 'package:flutter_test/flutter_test.dart';

const _service =
    '69a5e952d7759585167e4f1673e55b747f7a27a84c0312cb3d12815ec19b9c70';

void main() {
  group('parseHuddleServicePubkeys', () {
    test('reads lowercase hex keys and drops malformed entries', () {
      final keys = parseHuddleServicePubkeys({
        'huddle_service_pubkeys': [
          _service.toUpperCase(),
          'not-a-key',
          42,
          'ab' * 31,
        ],
      });
      expect(keys, {_service});
    });

    test('a relay without the field advertises no services', () {
      expect(parseHuddleServicePubkeys({'name': 'relay'}), isEmpty);
      expect(parseHuddleServicePubkeys('not a document'), isEmpty);
      expect(
        parseHuddleServicePubkeys({'huddle_service_pubkeys': 'x'}),
        isEmpty,
      );
    });
  });

  group('isHuddleServiceSigner', () {
    test('matches the advertised signer regardless of case', () {
      expect(isHuddleServiceSigner(_service.toUpperCase(), {_service}), isTrue);
    });

    test('never matches people or an empty signer', () {
      expect(isHuddleServiceSigner('ab' * 32, {_service}), isFalse);
      expect(isHuddleServiceSigner(null, {_service}), isFalse);
      expect(isHuddleServiceSigner('', {_service}), isFalse);
      expect(isHuddleServiceSigner(_service, const {}), isFalse);
    });
  });
}
