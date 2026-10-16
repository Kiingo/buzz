part of '../guest_digest_page.dart';

class _DayPicker extends StatelessWidget {
  const _DayPicker({required this.date, required this.onChanged});

  /// YYYY-MM-DD (UTC).
  final String date;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    final day = DateTime.tryParse('${date}T00:00:00Z');
    final today = DateTime.now().toUtc();
    final latest = DateTime.utc(today.year, today.month, today.day);
    final canGoForward = day != null && day.isBefore(latest);

    void shift(int days) {
      if (day == null) return;
      onChanged(digestDateString(day.add(Duration(days: days))));
    }

    Future<void> pick() async {
      final picked = await showDatePicker(
        context: context,
        initialDate: day ?? latest,
        firstDate: latest.subtract(const Duration(days: 365)),
        lastDate: latest,
      );
      if (picked != null) {
        onChanged(
          digestDateString(DateTime.utc(picked.year, picked.month, picked.day)),
        );
      }
    }

    return Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: Grid.gutter,
        vertical: Grid.xxs,
      ),
      child: Row(
        children: [
          IconButton(
            tooltip: 'Previous day',
            onPressed: day == null ? null : () => shift(-1),
            icon: const Icon(LucideIcons.chevronLeft),
          ),
          Expanded(
            child: TextButton.icon(
              key: const ValueKey('guest-digest-date'),
              onPressed: () => unawaited(pick()),
              icon: const Icon(LucideIcons.calendar, size: 16),
              label: Text(formatDigestDay(date)),
            ),
          ),
          IconButton(
            tooltip: 'Next day',
            onPressed: canGoForward ? () => shift(1) : null,
            icon: const Icon(LucideIcons.chevronRight),
          ),
        ],
      ),
    );
  }
}
