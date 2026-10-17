/// Kiingo mission reply metadata carried as event tags instead of chat text.
/// Mirrors desktop `replyDetails.ts`.
library;

const kiingoMissionTag = 'kiingo-mission';
const kiingoDetailsUrlTag = 'kiingo-details';

final _uuid = RegExp(
  r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
);

/// The mission behind an agent reply and its HTTPS Kiingo page.
class ReplyDetails {
  final String? missionId;
  final Uri? detailsUrl;

  const ReplyDetails({this.missionId, this.detailsUrl});

  bool get hasMission => missionId != null || detailsUrl != null;
}

String? _single(List<List<String>> tags, String name) {
  final values = [
    for (final tag in tags)
      if (tag.length > 1 && tag[0] == name) tag[1],
  ];
  return values.length == 1 ? values.single : null;
}

/// Missing, duplicated or malformed tags yield nulls, never a partial or
/// unsafe link.
ReplyDetails readReplyDetails(List<List<String>> tags) {
  final mission = _single(tags, kiingoMissionTag)?.toLowerCase();
  final rawUrl = _single(tags, kiingoDetailsUrlTag);
  final url = rawUrl != null && rawUrl.length <= 512
      ? Uri.tryParse(rawUrl)
      : null;
  return ReplyDetails(
    missionId: mission != null && _uuid.hasMatch(mission) ? mission : null,
    detailsUrl:
        url != null &&
            url.scheme == 'https' &&
            url.host.isNotEmpty &&
            url.userInfo.isEmpty
        ? url
        : null,
  );
}

/// Kiingo's mission acknowledgment and "not replied yet" notices, which used
/// to post into chat before every agent answer. Kiingo no longer posts them;
/// agent messages that are exactly these are hidden from the timeline.
/// Terminal outcomes ("Stopped as requested.") stay visible.
const _retiredMissionNoticePrefixes = [
  'Kiingo platform notice — request received; your agent will reply in this thread',
  'Kiingo platform notice — your agent has not replied yet',
];

bool isRetiredMissionNotice(String content) =>
    _retiredMissionNoticePrefixes.any(content.startsWith);
