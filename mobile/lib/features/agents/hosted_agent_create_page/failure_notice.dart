part of '../hosted_agent_create_page.dart';

/// Why a create did not produce an agent, and whether anything was left
/// behind.
class _FailureNotice extends StatelessWidget {
  const _FailureNotice({
    required this.failure,
    required this.retryingCleanup,
    required this.onRetryCleanup,
  });

  final HostedCreateFailed failure;
  final bool retryingCleanup;
  final VoidCallback onRetryCleanup;

  @override
  Widget build(BuildContext context) {
    final error = failure.error;
    final remediation = error.remediationUrl;
    final supportId = error.supportId;
    return Container(
      key: const ValueKey('hosted-agent-create-failure'),
      margin: const EdgeInsets.symmetric(horizontal: Grid.gutter),
      padding: const EdgeInsets.all(Grid.xs),
      decoration: BoxDecoration(
        color: context.colors.errorContainer.withValues(alpha: 0.4),
        borderRadius: BorderRadius.circular(Radii.container),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text("The agent wasn't created", style: context.textTheme.titleSmall),
          const SizedBox(height: Grid.half),
          Text(error.message, style: context.textTheme.bodyMedium),
          if (supportId != null) ...[
            const SizedBox(height: Grid.half),
            SelectableText(
              'Support ID: $supportId',
              style: context.textTheme.bodySmall?.copyWith(
                color: context.colors.onSurfaceVariant,
              ),
            ),
          ],
          const SizedBox(height: Grid.xxs),
          Text(
            failure.cleanupConfirmed
                ? 'Nothing was left behind.'
                : failure.cleanupReason ??
                      "Couldn't confirm the half-created agent was removed.",
            style: context.textTheme.bodySmall?.copyWith(
              color: failure.cleanupConfirmed
                  ? context.colors.onSurfaceVariant
                  : context.colors.error,
            ),
          ),
          if (remediation != null || !failure.cleanupConfirmed) ...[
            const SizedBox(height: Grid.xxs),
            Wrap(
              spacing: Grid.xxs,
              children: [
                if (remediation != null)
                  FilledButton.tonal(
                    onPressed: () => unawaited(_openExternal(remediation)),
                    child: const Text('Open'),
                  ),
                if (!failure.cleanupConfirmed)
                  TextButton(
                    key: const ValueKey('hosted-agent-retry-cleanup'),
                    onPressed: retryingCleanup ? null : onRetryCleanup,
                    child: Text(
                      retryingCleanup ? 'Cleaning up…' : 'Try cleanup again',
                    ),
                  ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}
