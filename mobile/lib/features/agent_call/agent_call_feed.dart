/// The agent host's call screen feed (contract v1 plus the additive v2
/// fields): the whole current state of the caller's own call, keyed by ask.
/// Status is the host's ledger, never inferred here; every v2 field is
/// optional.
library;

String? _string(Object? value) => value is String ? value : null;

String? _nested(Object? value, String key) =>
    value is Map ? _string(value[key]) : null;

List<Map<String, Object?>> _maps(Object? value) => value is List
    ? value.whereType<Map<String, Object?>>().toList(growable: false)
    : const [];

const _terminal = {'answered', 'not_answered', 'failed'};

class AgentCallLink {
  const AgentCallLink({required this.label, required this.url});

  final String label;
  final String url;
}

/// Only https links are opened from the call screen.
String? safeHttpsUrl(String? url) {
  if (url == null) return null;
  final uri = Uri.tryParse(url);
  return uri != null && uri.scheme == 'https' && uri.host.isNotEmpty
      ? uri.toString()
      : null;
}

class AgentCallAsk {
  const AgentCallAsk({
    required this.askKey,
    required this.kind,
    required this.text,
    required this.status,
    required this.statusReason,
    required this.title,
    required this.nowLine,
    required this.resultText,
    required this.links,
    required this.archivedAt,
    required this.pinnedAt,
    required this.cancelledAt,
    required this.canCancel,
  });

  final String askKey;
  final String kind;
  final String text;
  final String status;
  final String? statusReason;
  final String? title;
  final String? nowLine;
  final String? resultText;
  final List<AgentCallLink> links;
  final String? archivedAt;
  final String? pinnedAt;
  final String? cancelledAt;
  final bool? canCancel;

  bool get isTerminal => _terminal.contains(status);

  static AgentCallAsk? tryParse(Map<String, Object?> json) {
    final key = _string(json['askKey']) ?? _string(json['utteranceId']);
    final status = _string(json['status']);
    if (key == null || status == null) return null;
    final actions = json['actions'];
    return AgentCallAsk(
      askKey: key,
      kind: _string(json['kind']) ?? 'ask',
      text: _string(json['text']) ?? '',
      status: status,
      statusReason: _string(json['statusReason']),
      title: _nested(json['title'], 'text'),
      nowLine:
          _nested(json['nowLine'], 'text') ?? _nested(json['progress'], 'text'),
      resultText: _nested(json['result'], 'text'),
      links: [
        for (final link in _maps(json['links']))
          if (safeHttpsUrl(_string(link['url'])) case final url?)
            AgentCallLink(label: _string(link['title']) ?? url, url: url),
      ],
      archivedAt: _string(json['archivedAt']),
      pinnedAt: _string(json['pinnedAt']),
      cancelledAt: _string(json['cancelledAt']),
      canCancel: actions is Map && actions['cancel'] is bool
          ? actions['cancel'] as bool
          : null,
    );
  }

  /// A short title: the host's title, else the caller's first words.
  String get displayTitle {
    final host = title?.trim();
    if (host != null && host.isNotEmpty) return host;
    final words = text.trim().split(RegExp(r'\s+'));
    final short = words.take(8).join(' ');
    return words.length > 8 ? '$short…' : short;
  }

  String get statusLabel {
    if (cancelledAt != null) return 'Cancelled';
    return switch (status) {
      'answered' => 'Done',
      'not_answered' => 'Not done',
      'failed' => 'Failed',
      _ => 'Working',
    };
  }

  /// The live line while working; null once terminal.
  String? get liveLine => isTerminal ? null : nowLine;
}

class AgentCallQuestion {
  const AgentCallQuestion({
    required this.id,
    required this.question,
    required this.options,
  });

  final String? id;
  final String question;
  final List<(int, String)> options;
}

class AgentCallHumanAsk {
  const AgentCallHumanAsk({
    required this.humanAskId,
    required this.state,
    required this.questions,
  });

  final String humanAskId;
  final String state;
  final List<AgentCallQuestion> questions;

  bool get isOpen => state == 'open' && questions.isNotEmpty;

  static AgentCallHumanAsk? tryParse(Object? value) {
    if (value is! Map<String, Object?>) return null;
    final id = _string(value['humanAskId']);
    if (id == null) return null;
    return AgentCallHumanAsk(
      humanAskId: id,
      state: _string(value['state']) ?? 'closed',
      questions: [
        for (final question in _maps(value['questions']))
          if (_string(question['question']) case final text?)
            AgentCallQuestion(
              id: _string(question['id']),
              question: text,
              options: [
                for (final option in _maps(question['options']))
                  if (option['index'] is int &&
                      _string(option['label']) != null)
                    (option['index'] as int, option['label'] as String),
              ],
            ),
      ],
    );
  }
}

class AgentCallFeed {
  const AgentCallFeed({
    required this.callId,
    required this.rev,
    required this.isLive,
    required this.contract,
    required this.destinationLabel,
    required this.asks,
    required this.humanAsk,
    required this.recapWritten,
    required this.recapSummary,
    required this.recapLinks,
  });

  final String callId;
  final String rev;
  final bool isLive;
  final int contract;
  final String? destinationLabel;
  final List<AgentCallAsk> asks;
  final AgentCallHumanAsk? humanAsk;

  /// Whether the post-call recap exists (`summary` may still be null while
  /// it is being written).
  final bool recapWritten;
  final String? recapSummary;
  final List<AgentCallLink> recapLinks;

  bool get isV2 => contract >= 2;

  static AgentCallFeed? tryParse(Map<String, Object?> json) {
    final callId = _string(json['callId']);
    final rev = _string(json['rev']);
    final asks = json['asks'];
    if (callId == null || rev == null || asks is! List) return null;
    final recap = json['recap'];
    return AgentCallFeed(
      callId: callId,
      rev: rev,
      isLive: json['state'] == 'live',
      contract: json['contract'] is int ? json['contract'] as int : 1,
      destinationLabel: _nested(json['destination'], 'label'),
      asks: [for (final ask in _maps(asks)) ?AgentCallAsk.tryParse(ask)],
      humanAsk: AgentCallHumanAsk.tryParse(json['humanAsk']),
      recapWritten: recap is Map,
      recapSummary: _nested(recap, 'summary'),
      recapLinks: recap is Map
          ? [
              for (final link in _maps(recap['links']))
                if (safeHttpsUrl(_string(link['url'])) case final url?)
                  AgentCallLink(label: _string(link['label']) ?? url, url: url),
            ]
          : const [],
    );
  }

  /// Answers fold under their question; archived asks are listed apart;
  /// pinned asks first (newest pin first), then oldest first.
  List<AgentCallAsk> get shownAsks {
    final shown = asks
        .where((ask) => ask.kind == 'ask' && ask.archivedAt == null)
        .toList();
    final pinned = shown.where((ask) => ask.pinnedAt != null).toList()
      ..sort((a, b) => b.pinnedAt!.compareTo(a.pinnedAt!));
    return [...pinned, ...shown.where((ask) => ask.pinnedAt == null)];
  }

  int get archivedCount =>
      asks.where((ask) => ask.kind == 'ask' && ask.archivedAt != null).length;

  bool get anyWorking =>
      asks.any((ask) => ask.kind == 'ask' && !ask.isTerminal);

  AgentCallHumanAsk? get openQuestion =>
      humanAsk != null && humanAsk!.isOpen ? humanAsk : null;

  /// Whether to keep following after hang-up: v2 until the recap summary
  /// is written.
  bool get wantsMore =>
      isLive || (isV2 && (!recapWritten || recapSummary == null));
}
