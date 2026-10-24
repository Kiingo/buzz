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

/// Most commands one list holds (the server caps registry skills lower and
/// says `truncated` when it cut the list; typing then searches with `?q=`).
const maxAgentCommands = 1200;

/// The server reads at most this many characters of a search.
const maxAgentCommandQueryChars = 64;

const _requestTimeout = Duration(seconds: 15);
const _maxResponseBytes = 2 * 1024 * 1024;
final _skillIdPattern = RegExp(r'^[A-Za-z0-9_-]{1,128}$');
final _namePattern = RegExp(r'^\S{1,256}$');

/// One entry of an agent's "/" autocomplete: a conversation command the
/// server intercepts (`/new`, `/sessions`), or a skill, sent as a native skill
/// invocation rather than prose. A skill is either installed for the agent or
/// another registry skill the person may use with it (run for that turn). In
/// a channel with several agents, the popup first offers the agents
/// ([AgentCommand.agent], named by its mention label).
@immutable
class AgentCommand {
  const AgentCommand.session({required this.name, required this.description})
    : kind = AgentCommandKind.session,
      skillId = null,
      argumentHint = null,
      source = null,
      displayName = null,
      agentPubkey = null;

  /// An agent to choose in a channel; [name] is its mention label.
  const AgentCommand.agent({
    required this.name,
    required String this.agentPubkey,
  }) : kind = AgentCommandKind.agent,
       skillId = null,
       description = null,
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
  }) : kind = AgentCommandKind.skill,
       agentPubkey = null;

  final AgentCommandKind kind;
  final String name;
  final String? skillId;
  final String? description;
  final String? argumentHint;

  /// Where a skill comes from; null for a session command.
  final AgentSkillSource? source;

  /// The registry's human name, when it differs from [name].
  final String? displayName;

  /// The agent an [AgentCommand.agent] row picks.
  final String? agentPubkey;

  /// The popup section this command is listed under.
  AgentCommandSection get section => switch (kind) {
    AgentCommandKind.agent => AgentCommandSection.agents,
    AgentCommandKind.session => AgentCommandSection.commands,
    AgentCommandKind.skill =>
      source == AgentSkillSource.registry
          ? AgentCommandSection.skills
          : AgentCommandSection.agentSkills,
  };

  @override
  bool operator ==(Object other) =>
      other is AgentCommand &&
      other.kind == kind &&
      other.name == name &&
      other.skillId == skillId &&
      other.description == description &&
      other.argumentHint == argumentHint &&
      other.source == source &&
      other.displayName == displayName &&
      other.agentPubkey == agentPubkey;

  @override
  int get hashCode => Object.hash(
    kind,
    name,
    skillId,
    description,
    argumentHint,
    source,
    displayName,
    agentPubkey,
  );
}

/// Installed for the agent, or another registry skill.
enum AgentSkillSource { installed, registry }

/// The popup's sections, in order.
enum AgentCommandSection {
  agents('Choose an agent'),
  commands('Commands'),
  agentSkills("This agent's skills"),
  skills('Skills');

  const AgentCommandSection(this.label);

  final String label;
}

enum AgentCommandKind { session, skill, agent }

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
  for (final entry in raw.take(maxAgentCommands)) {
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

/// Whether a commands body says the server cut the list short.
bool agentCommandsBodyTruncated(Object? body) =>
    body is Map && body['truncated'] == true;

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
  int limit = maxAgentCommands,
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
  /// the list for [etag] is unchanged (304). A 1:1 DM asks for the private
  /// list, a channel or thread for the group one (the server re-checks every
  /// pick against the conversation it is sent in).
  /// With [query], the server searches the full list (for a list it cut).
  Future<({List<AgentCommand>? commands, String? etag, bool truncated})> fetch(
    String agentPublicKey, {
    String? etag,
    AgentCommandAudience audience = AgentCommandAudience.private,
    String? query,
  }) async {
    final search = normalizeAgentCommandQuery(query ?? '');
    final url =
        '${route.baseUrl}/agents/${Uri.encodeComponent(agentPublicKey)}/commands?audience=${audience.name}'
        '${search.isEmpty ? '' : '&q=${Uri.encodeQueryComponent(search)}'}';
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
        return (commands: null, etag: etag, truncated: false);
      }
      if (response.statusCode != 200 ||
          response.bodyBytes.length > _maxResponseBytes) {
        throw StateError('agent_commands_${response.statusCode}');
      }
      final body = jsonDecode(utf8.decode(response.bodyBytes));
      final commands = parseAgentCommands(body, agentPublicKey: agentPublicKey);
      if (commands == null) throw StateError('agent_commands_malformed');
      return (
        commands: commands,
        etag: response.headers['etag'],
        truncated: agentCommandsBodyTruncated(body),
      );
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

/// Which conversation a command list is for: a 1:1 DM, or a channel or
/// thread (only the organization's and public skills, and session commands
/// only for the agent's owner).
enum AgentCommandAudience { private, group }

/// What follows "/" as the server searches it: trimmed, lowercased, bounded.
String normalizeAgentCommandQuery(String query) {
  final text = query.trim().toLowerCase();
  return text.length > maxAgentCommandQueryChars
      ? text.substring(0, maxAgentCommandQueryChars).trim()
      : text;
}

typedef _CachedAgentCommands = ({
  List<AgentCommand> commands,
  String? etag,
  bool truncated,
});

/// Last good list and ETag per agent key and audience, for revalidation.
final _agentCommandsCacheProvider = Provider<Map<String, _CachedAgentCommands>>(
  (ref) => {},
);

/// Whether the last list for this agent and audience was cut short, so a
/// typed query should also be searched on the server.
bool agentCommandsTruncated(
  WidgetRef ref,
  String agentPublicKey,
  AgentCommandAudience audience,
) =>
    ref
        .read(_agentCommandsCacheProvider)['${agentPublicKey.toLowerCase()}:'
            '${audience.name}']
        ?.truncated ??
    false;

Future<List<AgentCommand>> _loadAgentCommands(
  Ref ref,
  String agentPublicKey,
  AgentCommandAudience audience,
) async {
  final client = ref.watch(agentCommandsClientProvider);
  if (client == null) return const [];
  final keepAlive = ref.keepAlive();
  final expiry = Timer(agentCommandsTtl, keepAlive.close);
  ref.onDispose(expiry.cancel);
  final cache = ref.read(_agentCommandsCacheProvider);
  final agent = agentPublicKey.toLowerCase();
  final key = '$agent:${audience.name}';
  final cached = cache[key];
  try {
    final fetched = await client.fetch(
      agent,
      etag: cached?.etag,
      audience: audience,
    );
    final commands = fetched.commands ?? cached?.commands ?? const [];
    cache[key] = (
      commands: commands,
      etag: fetched.etag,
      truncated: fetched.commands == null
          ? (cached?.truncated ?? false)
          : fetched.truncated,
    );
    return commands;
  } catch (error) {
    debugPrint('[AgentCommands] fetch failed: $error');
    return const [];
  }
}

/// The "/" commands for the agent with this lowercase key in a 1:1 DM.
/// Fetched lazily the first time the popup opens for that agent and reused
/// for [agentCommandsTtl]; any failure is an empty list (no popup).
final agentCommandsProvider = FutureProvider.autoDispose
    .family<List<AgentCommand>, String>(
      (ref, agentPublicKey) =>
          _loadAgentCommands(ref, agentPublicKey, AgentCommandAudience.private),
    );

/// The same for a channel or thread: the group list.
final agentGroupCommandsProvider = FutureProvider.autoDispose
    .family<List<AgentCommand>, String>(
      (ref, agentPublicKey) =>
          _loadAgentCommands(ref, agentPublicKey, AgentCommandAudience.group),
    );

/// A server search of an agent's full list: what follows "/" in a list the
/// server cut short. Reused for [agentCommandsTtl]; failure is no matches.
final agentCommandSearchProvider = FutureProvider.autoDispose
    .family<
      List<AgentCommand>,
      ({String agent, AgentCommandAudience audience, String query})
    >((ref, search) async {
      final client = ref.watch(agentCommandsClientProvider);
      final query = normalizeAgentCommandQuery(search.query);
      if (client == null || query.isEmpty) return const [];
      final keepAlive = ref.keepAlive();
      final expiry = Timer(agentCommandsTtl, keepAlive.close);
      ref.onDispose(expiry.cancel);
      try {
        final fetched = await client.fetch(
          search.agent.toLowerCase(),
          audience: search.audience,
          query: query,
        );
        return fetched.commands ?? const [];
      } catch (error) {
        debugPrint('[AgentCommands] search failed: $error');
        return const [];
      }
    });

/// [first], then the entries of [second] not already listed (by kind and
/// name).
List<AgentCommand> mergeAgentCommands(
  List<AgentCommand> first,
  List<AgentCommand> second,
) {
  final seen = <String>{};
  return [
    for (final command in [...first, ...second])
      if (seen.add('${command.kind.name}:${command.name.toLowerCase()}'))
        command,
  ];
}
