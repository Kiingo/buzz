part of '../hosted_agent_create_page.dart';

/// "Where it runs" leads the form, as on desktop. The phone cannot run an
/// agent itself, so the hosted destination is the one choice; running on a
/// computer stays a desktop create.
class _WhereItRunsSection extends StatelessWidget {
  const _WhereItRunsSection({required this.providerName});

  final String providerName;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        AppListCard(
          label: 'Where it runs',
          verticalPadding: Grid.twelve,
          children: [
            Semantics(
              selected: true,
              child: Padding(
                key: const ValueKey('hosted-agent-destination'),
                padding: const EdgeInsets.symmetric(
                  horizontal: Grid.xs,
                  vertical: Grid.twelve,
                ),
                child: Row(
                  children: [
                    Icon(
                      HostedAgentIcons.cloud,
                      size: 20,
                      color: context.colors.onSurface,
                    ),
                    const SizedBox(width: Grid.twelve),
                    Expanded(
                      child: Text(
                        providerName,
                        style: context.textTheme.bodyLarge,
                      ),
                    ),
                    Icon(
                      BuzzIcons.check,
                      size: 18,
                      color: context.colors.primary,
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
        _Caption(
          '$providerName runs the agent for you and holds the agent\'s key '
          'while it does. To run an agent on your own computer, create it in '
          'Buzz on desktop.',
        ),
      ],
    );
  }
}
