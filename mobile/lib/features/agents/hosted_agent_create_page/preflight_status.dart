part of '../hosted_agent_create_page.dart';

enum _PreflightPhase { idle, checking, ready, notReady, failed }

/// The owner-readiness check for one exact configuration ([key]).
@immutable
class _PreflightState {
  const _PreflightState({
    required this.key,
    required this.phase,
    this.result,
    this.error,
  });

  static const idle = _PreflightState(key: '', phase: _PreflightPhase.idle);

  final String key;
  final _PreflightPhase phase;
  final HostedPreflight? result;
  final String? error;

  /// Create is allowed only after a check of the *current* configuration
  /// came back ready; checking or a failed check fails closed.
  bool allowsCreate(String currentKey) =>
      key == currentKey && phase == _PreflightPhase.ready;
}

class _PreflightStatus extends StatelessWidget {
  const _PreflightStatus({required this.state, required this.onRecheck});

  final _PreflightState state;
  final VoidCallback onRecheck;

  @override
  Widget build(BuildContext context) {
    final result = state.result;
    final notice = result?.notice;
    final Widget body = switch (state.phase) {
      _PreflightPhase.idle => const SizedBox.shrink(),
      _PreflightPhase.checking => Row(
        children: [
          const SizedBox(
            width: 16,
            height: 16,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
          const SizedBox(width: Grid.xxs),
          Text(
            'Checking your account…',
            style: context.textTheme.bodySmall?.copyWith(
              color: context.colors.onSurfaceVariant,
            ),
          ),
        ],
      ),
      _PreflightPhase.ready => Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            LucideIcons.circleCheck,
            size: 16,
            color: context.appColors.success,
          ),
          const SizedBox(width: Grid.xxs),
          Expanded(
            child: Text(
              'Ready to create.',
              style: context.textTheme.bodySmall?.copyWith(
                color: context.colors.onSurfaceVariant,
              ),
            ),
          ),
        ],
      ),
      _PreflightPhase.notReady || _PreflightPhase.failed => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(
                LucideIcons.circleAlert,
                size: 16,
                color: context.appColors.warning,
              ),
              const SizedBox(width: Grid.xxs),
              Expanded(
                child: Text(
                  state.phase == _PreflightPhase.failed
                      ? (state.error ?? describeHostedAgentError(''))
                      : (result?.message ??
                            "Your account isn't ready to run this agent yet."),
                  style: context.textTheme.bodySmall,
                ),
              ),
            ],
          ),
          const SizedBox(height: Grid.xxs),
          Wrap(
            spacing: Grid.xxs,
            children: [
              if (result?.actionUrl case final url?)
                FilledButton.tonal(
                  key: const ValueKey('hosted-agent-preflight-action'),
                  onPressed: () => unawaited(_openExternal(url)),
                  child: Text(result?.actionLabel ?? 'Open'),
                ),
              TextButton(
                key: const ValueKey('hosted-agent-preflight-recheck'),
                onPressed: onRecheck,
                child: const Text('Check again'),
              ),
            ],
          ),
        ],
      ),
    };
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        Grid.gutter + Grid.xxs,
        Grid.xxs,
        Grid.gutter + Grid.xxs,
        0,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          body,
          if (notice != null) ...[
            const SizedBox(height: Grid.xxs),
            Text(
              notice,
              style: context.textTheme.bodySmall?.copyWith(
                color: context.colors.onSurfaceVariant,
              ),
            ),
          ],
        ],
      ),
    );
  }
}
