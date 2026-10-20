import 'package:buzz/shared/agent_details/agent_summary.dart';
import 'package:flutter_test/flutter_test.dart';

const _agent =
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

Map<String, Object?> _body({Map<String, Object?> extra = const {}}) => {
  'contract_version': 1,
  'agent_public_key': _agent,
  'agent': {
    'id': '00000000-0000-4000-8000-000000000001',
    'name': 'Assistant',
    'description': 'Shared agent.',
    'status': 'enabled',
  },
  'owner': {'principal_type': 'Organization', 'display_name': null},
  'viewer_role': 'Operator',
  'execution': {
    'harness': 'codex',
    'model': 'gpt-6.1-sol',
    'effort': 'high',
    'tier': 'auto',
    'pinned': true,
    'resolved_model': null,
    'resolved_effort': null,
    'unavailable_reason': 'buzz_codex_subscription_not_connected',
  },
  'location': {'kind': 'kiingo_compute', 'machine_name': null},
  'viewer_session': {
    'session_id': 's1',
    'harness': 'codex',
    'title': 'Q3 plan',
    'turn_count': 4,
    'started_at': '2026-10-20T01:00:00.000Z',
    'last_activity_at': '2026-10-20T02:00:00.000Z',
  },
  'session_controls': true,
  'skills': [
    {'id': 'a', 'name': 'research', 'description': null},
  ],
  'tools': {'kiingo_mcp': true, 'execution_trust': 'full'},
  'edit_url': 'https://dashboard.example.com/team/agents/x',
  ...extra,
};

void main() {
  test('parses the summary contract', () {
    final summary = parseAgentSummary(_body(), agentPublicKey: _agent)!;
    expect(summary.name, 'Assistant');
    expect(summary.ownerIsOrganization, isTrue);
    expect(summary.execution!.model, 'gpt-6.1-sol');
    expect(summary.execution!.pinned, isTrue);
    expect(summary.runsOnMachine, isFalse);
    expect(summary.session!.turnCount, 4);
    expect(summary.skills, ['research']);
    expect(summary.toolTrust, 'full');
    expect(summary.editUrl.toString(), contains('/team/agents/x'));
  });

  test('rejects another agent or contract, and non-https edit links', () {
    expect(parseAgentSummary(_body(), agentPublicKey: 'b' * 64), isNull);
    expect(
      parseAgentSummary(
        _body(extra: {'contract_version': 2}),
        agentPublicKey: _agent,
      ),
      isNull,
    );
    expect(
      parseAgentSummary(
        _body(extra: {'edit_url': 'javascript:alert(1)'}),
        agentPublicKey: _agent,
      )!.editUrl,
      isNull,
    );
  });
}
