import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:http/http.dart' as http;

import '../guest_access/guest_access_client.dart';
import '../relay/relay.dart';
import 'agent_dm_delegations.dart';

/// The host's Buzz mount for this app; the owner's delegation routes live
/// beside the call routes there.
const delegationRouteMount = '/api/buzz-voice/ios';

/// The cards long-poll waits up to 20 s on the host.
const _requestTimeout = Duration(seconds: 35);
const _retry = Duration(seconds: 15);
const _retryMax = Duration(minutes: 5);

/// A hidden board looks again this rarely (ownership can change).
const _hiddenRecheck = Duration(minutes: 10);

class DelegationApiException implements Exception {
  const DelegationApiException(this.status, this.code);

  final int? status;
  final String? code;

  /// Not the owner, not a hosted agent, or a host without the routes.
  bool get isRefusal => status == 403 || status == 404 || status == 405;

  @override
  String toString() => 'DelegationApiException($status, $code)';
}

/// The owner's delegation routes, every request NIP-98 signed by the
/// signed-in user (exact URL with query, method and the SHA-256 of the
/// exact body bytes) with `X-Buzz-Community`. The host answers only the
/// agent's owner (D5).
class DelegationClient {
  DelegationClient({
    required this.origin,
    required this.communityId,
    required String nsec,
    http.Client? httpClient,
  }) : _nsec = nsec,
       _http = httpClient;

  /// The host's origin, such as `https://api.kiingo.com`.
  final String origin;
  final String communityId;
  final String _nsec;
  final http.Client? _http;

  Future<Object?> send(String method, String path, [Object? body]) async {
    final url = '$origin$delegationRouteMount/$path';
    final bytes = body == null ? const <int>[] : utf8.encode(jsonEncode(body));
    final request = http.Request(method, Uri.parse(url))
      ..followRedirects = false
      ..headers['Accept'] = 'application/json'
      ..headers['X-Buzz-Community'] = communityId
      ..headers['Authorization'] = buildNip98AuthHeader(
        method: method,
        url: url,
        bodyBytes: bytes,
        nsec: _nsec,
      );
    if (body != null) {
      request.headers['Content-Type'] = 'application/json';
      request.bodyBytes = bytes;
    } else if (method != 'GET') {
      request.headers['Content-Length'] = '0';
    }
    final client = _http ?? http.Client();
    try {
      final response = await client.send(request).timeout(_requestTimeout);
      final status = response.statusCode;
      final declared = response.contentLength;
      if (declared != null && declared > guestAccessMaxResponseBytes) {
        throw DelegationApiException(status, 'response_too_large');
      }
      final buffer = BytesBuilder(copy: false);
      await for (final chunk in response.stream.timeout(_requestTimeout)) {
        if (buffer.length + chunk.length > guestAccessMaxResponseBytes) {
          throw DelegationApiException(status, 'response_too_large');
        }
        buffer.add(chunk);
      }
      final raw = buffer.takeBytes();
      Object? decoded;
      if (raw.isNotEmpty) {
        try {
          decoded = jsonDecode(utf8.decode(raw));
        } on FormatException {
          decoded = null;
        }
      }
      if (status < 200 || status >= 300) {
        final code = decoded is Map && decoded['error'] is String
            ? decoded['error'] as String
            : null;
        throw DelegationApiException(status, code);
      }
      return decoded;
    } on TimeoutException {
      throw const DelegationApiException(null, 'timeout');
    } on http.ClientException {
      throw const DelegationApiException(null, 'network');
    } finally {
      if (_http == null) client.close();
    }
  }

  /// The Kiingo agent behind a Buzz agent key (the call settings read maps
  /// it), or null when there is none.
  Future<String?> agentIdFor(String agentPubkey) async {
    final body = await send(
      'GET',
      'settings?agentPubkey=${Uri.encodeQueryComponent(agentPubkey)}',
    );
    final outer = body is Map ? body : null;
    final data = outer?['data'] is Map ? outer!['data'] as Map : outer;
    final effective = data?['effective'];
    final agentId = effective is Map ? effective['agentId'] : null;
    return isDelegationUuid(agentId) ? (agentId as String).toLowerCase() : null;
  }

  Future<DelegationPoll> cards(String agentId, String? rev) async {
    final poll = DelegationPoll.tryParse(
      await send('GET', delegationsPath(agentId, rev)),
    );
    if (poll == null) {
      throw const DelegationApiException(null, 'response_invalid');
    }
    return poll;
  }

  Future<List<DelegationAsk>> asks(String agentId, String delegationId) async =>
      parseDelegationAsks(
        await send('GET', 'agents/$agentId/delegations/$delegationId'),
      );

  Future<void> answer(String agentId, String askId, String answer) => send(
    'POST',
    'agents/$agentId/delegations/asks/$askId/answer',
    {'answer': answer},
  );

  Future<void> cancel(String agentId, String delegationId) => send(
    'POST',
    'agents/$agentId/delegations/$delegationId/cancel',
    {'reason': 'Stopped by the owner from Buzz.'},
  );

  /// "Stop all": the number of workers stopped.
  Future<int> cancelAll(String agentId) async {
    final body = await send('POST', 'agents/$agentId/delegations/cancel-all', {
      'reason': 'Stopped by the owner from Buzz.',
    });
    final ids = body is Map ? body['cancelledIds'] : null;
    return ids is List ? ids.length : 0;
  }
}

/// The reader's delegation client, or null when this build has no hosted
/// route for the active community.
final delegationClientProvider = Provider<DelegationClient?>((ref) {
  final route = ref.watch(guestAccessRouteProvider);
  final nsec = ref.watch(relayConfigProvider.select((config) => config.nsec));
  final uri = route == null ? null : Uri.tryParse(route.baseUrl);
  if (route == null || uri == null || uri.host.isEmpty) return null;
  if (nsec == null || nsec.isEmpty) return null;
  return DelegationClient(
    origin: uri.origin,
    communityId: route.communityId,
    nsec: nsec,
  );
});

/// What the board shows.
@immutable
sealed class DelegationBoardState {
  const DelegationBoardState();
}

class DelegationBoardLoading extends DelegationBoardState {
  const DelegationBoardLoading();
}

/// Not the owner, not a hosted agent, or a host without the routes.
class DelegationBoardHidden extends DelegationBoardState {
  const DelegationBoardHidden();
}

class DelegationBoardReady extends DelegationBoardState {
  const DelegationBoardReady({
    required this.agentId,
    required this.page,
    required this.asks,
    this.stale = false,
  });

  final String agentId;
  final DelegationPage page;

  /// Open worker asks, by delegation id.
  final Map<String, List<DelegationAsk>> asks;

  /// The last poll failed; the page shown is the last good one.
  final bool stale;
}

/// One agent's live board: a long-poll on the cards route while anything
/// watches it (auto-dispose), fenced by generation so a read that lands
/// after disposal goes nowhere.
class DelegationBoardNotifier extends Notifier<DelegationBoardState> {
  DelegationBoardNotifier(this.agentPubkey);

  final String agentPubkey;
  int _generation = 0;
  String? _agentId;
  String? _rev;
  Completer<void>? _wake;

  @override
  DelegationBoardState build() {
    final client = ref.watch(delegationClientProvider);
    final generation = ++_generation;
    _agentId = null;
    _rev = null;
    ref.onDispose(() {
      _generation += 1;
      _wakeUp();
    });
    if (client == null) return const DelegationBoardHidden();
    unawaited(_run(client, generation));
    return const DelegationBoardLoading();
  }

  bool _live(int generation) => generation == _generation && ref.mounted;

  void _wakeUp() {
    final wake = _wake;
    _wake = null;
    if (wake != null && !wake.isCompleted) wake.complete();
  }

  Future<void> _sleep(Duration duration) {
    final wake = Completer<void>();
    _wake = wake;
    final timer = Timer(duration, () {
      if (!wake.isCompleted) wake.complete();
    });
    return wake.future.whenComplete(timer.cancel);
  }

  void _publish(int generation, DelegationBoardState next) {
    if (_live(generation)) state = next;
  }

  Future<void> _apply(
    DelegationClient client,
    int generation,
    String agentId,
    DelegationPage page,
  ) async {
    final asks = <String, List<DelegationAsk>>{};
    await Future.wait([
      for (final card in page.cards.where((card) => card.pendingAsksCount > 0))
        client
            .asks(agentId, card.delegationId)
            .then((open) {
              if (open.isNotEmpty) asks[card.delegationId] = open;
            })
            .catchError((Object _) {}),
    ]);
    _publish(
      generation,
      DelegationBoardReady(agentId: agentId, page: page, asks: asks),
    );
  }

  Future<void> _run(DelegationClient client, int generation) async {
    var backoff = _retry;
    while (_live(generation)) {
      try {
        _agentId ??= await client.agentIdFor(agentPubkey);
        if (!_live(generation)) return;
        final agentId = _agentId;
        if (agentId == null) {
          _publish(generation, const DelegationBoardHidden());
          await _sleep(_hiddenRecheck);
          continue;
        }
        final poll = await client.cards(agentId, _rev);
        if (!_live(generation)) return;
        _rev = poll.rev;
        final page = poll.page;
        if (page != null) await _apply(client, generation, agentId, page);
        backoff = _retry;
      } on DelegationApiException catch (error) {
        if (!_live(generation)) return;
        _rev = null;
        if (error.isRefusal) {
          _agentId = null;
          _publish(generation, const DelegationBoardHidden());
          await _sleep(_hiddenRecheck);
          continue;
        }
        final current = state;
        if (current is DelegationBoardReady) {
          _publish(
            generation,
            DelegationBoardReady(
              agentId: current.agentId,
              page: current.page,
              asks: current.asks,
              stale: true,
            ),
          );
        }
        await _sleep(backoff);
        final doubled = backoff * 2;
        backoff = doubled > _retryMax ? _retryMax : doubled;
      }
    }
  }

  /// Reads the board now (after an action), outside the waiting long-poll.
  Future<void> _refresh(DelegationClient client, String agentId) async {
    final generation = _generation;
    try {
      final poll = await client.cards(agentId, null);
      final page = poll.page;
      if (page != null && _live(generation)) {
        await _apply(client, generation, agentId, page);
      }
    } on DelegationApiException {
      // The long-poll picks it up.
    }
  }

  (DelegationClient, String) _ready() {
    final client = ref.read(delegationClientProvider);
    final current = state;
    if (client == null || current is! DelegationBoardReady) {
      throw const DelegationApiException(null, 'delegations_unavailable');
    }
    return (client, current.agentId);
  }

  /// The owner's answer to a worker ask, straight to the worker (§10.1).
  Future<void> answer(String askId, String answer) async {
    final (client, agentId) = _ready();
    await client.answer(agentId, askId, answer);
    await _refresh(client, agentId);
  }

  /// Stops one worker's turn; its session survives.
  Future<void> cancel(String delegationId) async {
    final (client, agentId) = _ready();
    await client.cancel(agentId, delegationId);
    await _refresh(client, agentId);
  }

  /// "Stop all": every running delegation of this agent; sessions are kept.
  Future<int> cancelAll() async {
    final (client, agentId) = _ready();
    final stopped = await client.cancelAll(agentId);
    await _refresh(client, agentId);
    return stopped;
  }
}

/// The delegation board of one agent, by its Buzz key (lowercase hex).
final delegationBoardProvider = NotifierProvider.autoDispose
    .family<DelegationBoardNotifier, DelegationBoardState, String>(
      DelegationBoardNotifier.new,
    );
