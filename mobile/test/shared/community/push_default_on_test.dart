import 'package:buzz/shared/community/community.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('new communities follow the build push default', () {
    final community = Community.create(
      name: 'Example',
      relayUrl: 'https://relay.example.com',
    );
    expect(
      community.pushNotificationsEnabled,
      Community.pushNotificationsDefaultOn,
    );
  });

  test('push stays off by default without BUZZ_PUSH_DEFAULT_ON', () {
    // Test runs do not pass the define, matching upstream behaviour.
    expect(Community.pushNotificationsDefaultOn, isFalse);
  });

  test('a stored community keeps its own setting', () {
    final stored = Community.create(
      name: 'Example',
      relayUrl: 'https://relay.example.com',
    ).copyWith(pushNotificationsEnabled: true);
    final restored = Community.fromJson(stored.toJson());
    expect(restored.pushNotificationsEnabled, isTrue);
  });
}
