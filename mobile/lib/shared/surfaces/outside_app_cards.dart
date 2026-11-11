/// Metadata only. Card content still comes through the owner's existing
/// signed per-surface read, with the same content-authority checks.
class OutsideAppCard {
  final String surfaceId;
  final int revision;
  final String conversationId;
  final String conversationTitle;
  final String appName;

  const OutsideAppCard({
    required this.surfaceId,
    required this.revision,
    required this.conversationId,
    required this.conversationTitle,
    required this.appName,
  });
}

class OutsideAppCardsPage {
  final List<OutsideAppCard> surfaces;
  final String? nextBefore;
  const OutsideAppCardsPage({required this.surfaces, this.nextBefore});
}

bool isOutsideCardsCursor(String value) =>
    RegExp(r'^v1\.[A-Za-z0-9_-]{32}$').hasMatch(value);

OutsideAppCardsPage decodeOutsideAppCards(Object? value) {
  final uuid = RegExp(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    caseSensitive: false,
  );
  if (value is! Map || value['surfaces'] is! List) {
    throw const FormatException('outside_cards_invalid');
  }
  final rows = value['surfaces'] as List;
  final next = value['nextBefore'];
  if (rows.length > 50 ||
      (next != null && (next is! String || !isOutsideCardsCursor(next)))) {
    throw const FormatException('outside_cards_invalid');
  }
  final cards = rows
      .map((row) {
        if (row is! Map ||
            row['surfaceId'] is! String ||
            !uuid.hasMatch(row['surfaceId'] as String) ||
            row['conversationId'] is! String ||
            !uuid.hasMatch(row['conversationId'] as String) ||
            row['revision'] is! int ||
            (row['revision'] as int) < 1 ||
            row['conversationTitle'] is! String ||
            (row['conversationTitle'] as String).length > 300 ||
            row['appName'] is! String ||
            (row['appName'] as String).length > 200) {
          throw const FormatException('outside_cards_invalid');
        }
        return OutsideAppCard(
          surfaceId: row['surfaceId'] as String,
          revision: row['revision'] as int,
          conversationId: row['conversationId'] as String,
          conversationTitle: row['conversationTitle'] as String,
          appName: row['appName'] as String,
        );
      })
      .toList(growable: false);
  return OutsideAppCardsPage(surfaces: cards, nextBefore: next as String?);
}
