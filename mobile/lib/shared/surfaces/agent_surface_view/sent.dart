part of '../agent_surface_view.dart';

/// The compact row of an email card whose email went out (Ross,
/// 2026-10-31): a check, "Sent", the time, the recipients (address first)
/// and the subject, all from the server's sent record. A tap opens and
/// closes the read-only card: no action is drawn on a sent card, and
/// nothing on a submitted or closed card takes an edit.
class _SentEmailRow extends StatefulWidget {
  final SurfaceSentEmail sent;
  final bool initiallyOpen;
  final Widget child;

  const _SentEmailRow({
    required this.sent,
    required this.initiallyOpen,
    required this.child,
  });

  @override
  State<_SentEmailRow> createState() => _SentEmailRowState();
}

class _SentEmailRowState extends State<_SentEmailRow> {
  late bool _open = widget.initiallyOpen;

  @override
  Widget build(BuildContext context) {
    final surface = _SurfaceScope.of(context).surface;
    final sent = widget.sent;
    final muted = context.colors.onSurfaceVariant;
    final when = formatSurfaceDate(sent.at);
    final recipients = sentRecipientsLine(surface, sent);
    final subject = sent.subject;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        Semantics(
          button: true,
          expanded: _open,
          label: [
            'Sent',
            ?when,
            recipients,
            if (subject != null) 'Subject: $subject',
          ].join(', '),
          hint: _open ? 'Hides what was sent' : 'Shows what was sent',
          excludeSemantics: true,
          child: InkWell(
            borderRadius: BorderRadius.circular(Grid.xxs),
            onTap: () => setState(() => _open = !_open),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: Grid.half),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(
                    _toneIcon('success'),
                    size: 16,
                    color: _toneColor(context, 'success'),
                  ),
                  const SizedBox(width: Grid.half),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text.rich(
                          TextSpan(
                            children: [
                              TextSpan(
                                text: 'Sent',
                                style: context.textTheme.bodyMedium?.copyWith(
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                              if (when != null)
                                TextSpan(
                                  text: '  $when',
                                  style: bodyExtraSmallTextStyle.copyWith(
                                    color: muted,
                                  ),
                                ),
                            ],
                          ),
                        ),
                        Text(
                          recipients,
                          maxLines: _open ? null : 2,
                          overflow: _open ? null : TextOverflow.ellipsis,
                          style: bodyExtraSmallTextStyle.copyWith(color: muted),
                        ),
                        if (subject != null)
                          Text(
                            subject,
                            maxLines: _open ? null : 1,
                            overflow: _open ? null : TextOverflow.ellipsis,
                            style: bodyExtraSmallTextStyle,
                          ),
                      ],
                    ),
                  ),
                  Icon(
                    _open ? Icons.expand_less : Icons.expand_more,
                    size: 18,
                    color: muted,
                  ),
                ],
              ),
            ),
          ),
        ),
        if (_open) ...[
          const SizedBox(height: Grid.xxs),
          IgnorePointer(child: widget.child),
        ],
      ],
    );
  }
}
