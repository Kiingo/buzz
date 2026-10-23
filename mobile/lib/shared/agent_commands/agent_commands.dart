import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:http/http.dart' as http;

import '../guest_access/guest_access_client.dart';
import '../relay/relay.dart';

/// Longest skill arguments a `buzz-skill` tag may carry (characters).
const maxAgentSkillArgsChars = 4000;

/// How long a fetched command list is reused before it is revalidated.
const agentCommandsTtl = Duration(minutes: 5);

const _requestTimeout = Duration(seconds: 15);
const _maxResponseBytes = 512 * 1024;
final _skillIdPattern = RegExp(r'^[A-Za-z0-9_-]{1,128}$');
final _namePattern = RegExp(r'^\S{1,256}$');

/// One entry of an agent's "/" autocomplete: a conversation command the
/// server intercepts (`/new`, `/sessions`), or a skill, sent as a native skill
/// invocation rather than prose. A skill is either installed for the agent or
/// another registry skill the person may use with it (run for that turn).
@immutable
class AgentCommand {
  const AgentCommand.session({required this.name, required this.description})
    : kind = AgentCommandKind.session,
      skillId = null,
      argumentHint = null,
      source = null,
      displayName = null;

  const AgentCommand.skill({
    required this.name,
    required String this.skillId,
    this.description,
    this.argumentHint,
    AgentSkillSource this.source = AgentSkillSource.installed,
    this.displayName,
  }) : kind = AgentCommandKind.skill;

  final AgentCommandKind kind;
  final String name;
  final String? skillId;
  final String? description;
  final String? argumentHint;

  /// Where a skill comes from; null for a session command.
  final AgentSkillSource? source;

  /// The registry's human name, when it differs from [name].
  final String? displayName;

  /// The popup section this command is listed under.
  AgentCommandSection get section => kind == AgentCommandKind.session
      ? AgentCommandSection.commands
      : source == AgentSkillSource.registry
      ? AgentCommandSection.skills
      : AgentCommandSection.agentSkills;

  @override
  bool operator ==(Object other) =>
      other is AgentCommand &&
      other.kind == kind &&
      other.name == name &&
      other.skillId == skillId &&
      other.description == description &&
      other.argumentHint == argumentHint &&
      other.source == source &&
      other.displayName == displayName;

  @override
  int get hashCode => Object.hash(
    kind,
    name,
    skillId,
    description,
    argumentHint,
    source,
    displayName,
  );
}

/// Installed for the agent, or another registry skill.
enum AgentSkillSource { installed, registry }

/// The popup's sections, in order.
enum AgentCommandSection {
  commands('Commands'),
  agentSkills("This agent's skills"),
  skills('Skills');

  const AgentCommandSection(this.label);

  final String label;
}

enum AgentCommandKind { session, skill }

String? _optionalText(Object? value) =>
    value is String && value.trim().isNotEmpty ? value.trim() : null;

/// The command list from a `GET /agents/{key}/commands` body, or `null` when
/// the body is not that contract (anything malformed shows no popup).
List<AgentCommand>? parseAgentCommands(
  Object? body, {
  required String agentPublicKey,
}) {
  if (body is! Map ||
      body['contract_version'] != 1 ||
      body['agent_public_key'] != agentPublicKey) {
    return null;
  }
  final raw = body['commands'];
  if (raw is! List) return null;
  final commands = <AgentCommand>[];
  for (final entry in raw) {
    if (entry is! Map) continue;
    final name = entry['name'];
    if (name is! String || !_namePattern.hasMatch(name)) continue;
    switch (entry['kind']) {
      case 'session':
        if (name != 'new' && name != 'sessions') continue;
        commands.add(
          AgentCommand.session(
            name: name,
            description: _optionalText(entry['description']) ?? '',
          ),
        );
      case 'skill':
        final skillId = entry['skill_id'];
        if (skillId is! String || !_skillIdPattern.hasMatch(skillId)) {
          continue;
        }
        commands.add(
          AgentCommand.skill(
            name: name,
            skillId: skillId,
            description: _optionalText(entry['description']),
            argumentHint: _optionalText(entry['argument_hint']),
            // Older servers list only installed skills.
            source: entry['source'] == 'registry'
                ? AgentSkillSource.registry
                : AgentSkillSource.installed,
            displayName: _optionalText(entry['display_name']),
          ),
        );
    }
  }
  return commands;
}

/// An open "/" query: the composer starts with `/` and the cursor is still
/// inside that first word.
@immutable
class AgentCommandQuery {
  const AgentCommandQuery(this.query);

  /// What follows the `/`, lowercased.
  final String query;
}

/// The "/" query at [cursor] in [text], or `null` when none is open.
AgentCommandQuery? findAgentCommandQuery(String text, int cursor) {
  if (!text.startsWith('/') || cursor < 1 || cursor > text.length) {
    return null;
  }
  final typed = text.substring(1, cursor);
  if (typed.contains(RegExp(r'\s'))) return null;
  return AgentCommandQuery(typed.toLowerCase());
}

/// How well [command] matches [query] (higher is better, 0 is no match): the
/// name itself, a name prefix, a word prefix, a substring, and from three
/// letters on the letters in order, then a description match.
int agentCommandMatchScore(AgentCommand command, String query) {
  final q = query.trim().toLowerCase();
  if (q.isEmpty) return 1;
  final name = command.name.toLowerCase();
  final display = (command.displayName ?? '').toLowerCase();
  if (name == q) return 100;
  if (name.startsWith(q)) return 90;
  final words = '$name $display'.split(RegExp(r'[\s._:-]+'));
  if (words.any((word) => word.startsWith(q))) return 80;
  if (name.contains(q) || display.contains(q)) return 70;
  // Short queries match names only: two letters in order, or inside a
  // description, match almost everything.
  if (q.length < 3) return 0;
  var at = 0;
  for (final letter in name.split('')) {
    if (letter == q[at]) {
      at += 1;
      if (at == q.length) return 50;
    }
  }
  return (command.description ?? '').toLowerCase().contains(q) ? 30 : 0;
}

/// Commands matching [query], grouped by section (commands, this agent's
/// skills, other skills) and best match first within each; ties keep the
/// server's order.
List<AgentCommand> filterAgentCommands(
  List<AgentCommand> commands,
  String query, {
  int limit = 40,
}) {
  final scored = <({AgentCommand command, int index, int score})>[];
  for (var index = 0; index < commands.length; index++) {
    final score = agentCommandMatchScore(commands[index], query);
    if (score > 0) {
      scored.add((command: commands[index], index: index, score: score));
    }
  }
  scored.sort((left, right) {
    final section = left.command.section.index.compareTo(
      right.command.section.index,
    );
    if (section != 0) return section;
    final score = right.score.compareTo(left.score);
    return score != 0 ? score : left.index.compareTo(right.index);
  });
  return scored.take(limit).map((entry) => entry.command).toList();
}

/// The `["buzz-skill", skill_id, args]` tag for a message that begins with a
/// skill the person picked from the popup, or none. [chosen] maps picked skill
/// names to their commands; typing a name by hand is an ordinary message.
List<List<String>> agentSkillInvocationTags(
  String text,
  Map<String, AgentCommand> chosen,
) {
  final trimmed = text.trimLeft();
  if (!trimmed.startsWith('/')) return const [];
  final match = RegExp(r'^/(\S+)(?:\s+([\s\S]*))?$').firstMatch(trimmed);
  if (match == null) return const [];
  final command = chosen[match.group(1)!];
  final skillId = command?.skillId;
  if (command == null ||
      command.kind != AgentCommandKind.skill ||
      skillId == null) {
    return const [];
  }
  final args = (match.group(2) ?? '').trim();
  if (args.runes.length > maxAgentSkillArgsChars) return const [];
  return [
    ['buzz-skill', skillId, args],
  ];
}

/// Fetches an agent's commands from the hosted guest route with NIP-98,
/// revalidating with the last ETag.
class AgentCommandsClient {
  AgentCommandsClient({
    required this.route,
    required String nsec,
    http.Client? httpClient,
  }) : _nsec = nsec,
       _http = httpClient;

  final GuestAccessRoute route;
  final String _nsec;
  final http.Client? _http;

  /// The commands and their ETag, or `null` commands when the server says
  /// the list for [etag] is unchanged (304). The popup is a 1:1 DM's, so it
  /// asks for the private list (the server re-checks every pick against the
  /// conversation it is sent in).
  Future<({List<AgentCommand>? commands, String? etag})> fetch(
    String agentPublicKey, {
    String? etag,
  }) async {
    final url =
        '${route.baseUrl}/agents/${Uri.encodeComponent(agentPublicKey)}/commands?audience=private';
    final request = http.Request('GET', Uri.parse(url))
      ..followRedirects = false
      ..headers['Authorization'] = buildNip98AuthHeader(
        method: 'GET',
        url: url,
        bodyBytes: const [],
        nsec: _nsec,
      )
      ..headers['X-Buzz-Community'] = route.communityId;
    if (etag != null) request.headers['If-None-Match'] = etag;
    final client = _http ?? http.Client();
    try {
      final streamed = await client.send(request).timeout(_requestTimeout);
      final response = await http.Response.fromStream(
        streamed,
      ).timeout(_requestTimeout);
      if (response.statusCode == 304 && etag != null) {
        return (commands: null, etag: etag);
      }
      if (response.statusCode != 200 ||
          response.bodyBytes.length > _maxResponseBytes) {
        throw StateError('agent_commands_${response.statusCode}');
      }
      final commands = parseAgentCommands(
        jsonDecode(utf8.decode(response.bodyBytes)),
        agentPublicKey: agentPublicKey,
      );
      if (commands == null) throw StateError('agent_commands_malformed');
      return (commands: commands, etag: response.headers['etag']);
    } finally {
      if (_http == null) client.close();
    }
  }
}

final agentCommandsClientProvider = Provider<AgentCommandsClient?>((ref) {
  final route = ref.watch(guestAccessRouteProvider);
  final nsec = ref.watch(relayConfigProvider.select((config) => config.nsec));
  if (route == null || nsec == null || nsec.isEmpty) return null;
  return AgentCommandsClient(route: route, nsec: nsec);
});

/// Last good list and ETag per agent key, for revalidation.
final _agentCommandsCacheProvider =
    Provider<Map<String, ({List<AgentCommand> commands, String? etag})>>(
      (ref) => {},
    );

/// The "/" commands for the agent with this lowercase key. Fetched lazily
/// the first time the popup opens for that agent and reused for
/// [agentCommandsTtl]; any failure is an empty list (no popup).
final agentCommandsProvider = FutureProvider.autoDispose
    .family<List<AgentCommand>, String>((ref, agentPublicKey) async {
      final client = ref.watch(agentCommandsClientProvider);
      if (client == null) return const [];
      final keepAlive = ref.keepAlive();
      final expiry = Timer(agentCommandsTtl, keepAlive.close);
      ref.onDispose(expiry.cancel);
      final cache = ref.read(_agentCommandsCacheProvider);
      final key = agentPublicKey.toLowerCase();
      final cached = cache[key];
      try {
        final fetched = await client.fetch(key, etag: cached?.etag);
        final commands = fetched.commands ?? cached?.commands ?? const [];
        cache[key] = (commands: commands, etag: fetched.etag);
        return commands;
      } catch (error) {
        debugPrint('[AgentCommands] fetch failed: $error');
        return const [];
      }
    });
