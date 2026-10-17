import 'package:buzz/features/channels/reply_details.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  const mission = '317b1210-8058-4108-9ad1-72295f165ac4';
  const url = 'https://dashboard.kiingo.com/team/missions/$mission';

  test('reads the mission and its https details page', () {
    final details = readReplyDetails([
      ['h', 'channel'],
      ['kiingo-mission', mission.toUpperCase()],
      ['kiingo-details', url],
    ]);
    expect(details.missionId, mission);
    expect(details.detailsUrl, Uri.parse(url));
    expect(details.hasMission, isTrue);
  });

  test('ignores missing, duplicated or unsafe values', () {
    expect(readReplyDetails(const []).hasMission, isFalse);
    final unsafe = readReplyDetails([
      ['kiingo-mission', 'not-a-uuid'],
      ['kiingo-details', 'javascript:alert(1)'],
    ]);
    expect(unsafe.missionId, isNull);
    expect(unsafe.detailsUrl, isNull);
    final duplicated = readReplyDetails([
      ['kiingo-mission', mission],
      ['kiingo-mission', mission],
      ['kiingo-details', 'http://dashboard.kiingo.com/x'],
    ]);
    expect(duplicated.missionId, isNull);
    expect(duplicated.detailsUrl, isNull);
  });
}
