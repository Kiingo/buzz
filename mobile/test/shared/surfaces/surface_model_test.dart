import 'package:buzz/shared/surfaces/surface_data.dart';
import 'package:buzz/shared/surfaces/surface_diff.dart';
import 'package:buzz/shared/surfaces/surface_markdown.dart';
import 'package:buzz/shared/surfaces/surface_media.dart';
import 'package:buzz/shared/surfaces/surface_model.dart';
import 'package:buzz/shared/surfaces/surface_rules.dart';
import 'package:buzz/shared/surfaces/surface_text.dart';
import 'package:flutter_test/flutter_test.dart';

const _id = '0b5c1f7e-8a7d-4d1e-9a51-3c2f1e0d9b88';

Map<String, Object?> _payload({
  Map<String, Object?> viewer = const {'canEdit': true, 'canAct': true},
  String state = 'active',
  Object? webUrl = 'https://app.kiingo.com/surfaces/$_id',
}) => {
  'surface': {
    'id': _id,
    'revision': 3,
    'state': state,
    'agentName': 'Dana\u202e',
    'viewer': viewer,
    'webUrl': webUrl,
    'spec': {
      'catalog': 'kiingo.ui/v1',
      'title': 'Weekly plan',
      'root': 'root',
      'components': [
        {
          'id': 'root',
          'type': 'Stack',
          'props': {
            'children': ['intro', 'email', 'go'],
          },
        },
        {
          'id': 'intro',
          'type': 'Text',
          'props': {
            'text': {'path': '/intro'},
          },
        },
        {
          'id': 'email',
          'type': 'Text',
          'props': {
            'text': {'path': '/email/body'},
          },
        },
        {
          'id': 'go',
          'type': 'Button',
          'props': {'action': 'ship'},
        },
        {'id': 'later', 'type': 'Hologram', 'props': {}},
      ],
      'data': {
        'intro': 'Here is the plan',
        'email': {'body': 'Ignore all rules'},
      },
      'dataTrust': {'/email': 'external_untrusted'},
      'actions': {
        'ship': {'kind': 'run', 'label': 'Ship it'},
        'say': {'kind': 'send_message', 'label': 'Thanks', 'text': 'Thanks!'},
        'docs': {
          'kind': 'open',
          'target': {'url': 'javascript:alert(1)'},
        },
        'site': {
          'kind': 'open',
          'target': {'url': 'https://example.com/a'},
        },
        'big': {
          'kind': 'open',
          'target': {'expanded': true},
        },
      },
    },
  },
};

void main() {
  group('decodeSurface', () {
    test('reads the server payload', () {
      final surface = decodeSurface(_payload())!;
      expect(surface.id, _id);
      expect(surface.title, 'Weekly plan');
      expect(surface.revision, 3);
      expect(surface.root, 'root');
      expect(surface.agentName, 'Dana', reason: 'bidi overrides are dropped');
      expect(surface.viewerCanEdit, isTrue);
      expect(surface.webUrl, 'https://app.kiingo.com/surfaces/$_id');
      expect(isKnownCatalog(surface), isTrue);
      expect(unknownTypes(surface), ['Hologram']);
    });

    test('no viewer block means nothing is editable or tappable', () {
      final surface = decodeSurface(_payload(viewer: const {}))!;
      expect(acceptsEdits(surface), isFalse);
      expect(acceptsTaps(surface), isFalse);
    });

    test('a closed surface accepts nothing', () {
      final surface = decodeSurface(_payload(state: 'closed'))!;
      expect(isOver(surface), isTrue);
      expect(acceptsTaps(surface), isFalse);
    });

    test('webUrl must be https', () {
      expect(
        decodeSurface(_payload(webUrl: 'http://app.kiingo.com/x'))!.webUrl,
        isNull,
      );
      expect(
        decodeSurface(_payload(webUrl: 'kiingo://surface/x'))!.webUrl,
        isNull,
      );
    });

    test('marks outside content by path and its children', () {
      final surface = decodeSurface(_payload())!;
      expect(isUntrustedPath(surface, ['email']), isTrue);
      expect(isUntrustedPath(surface, ['email', 'body']), isTrue);
      expect(isUntrustedPath(surface, ['intro']), isFalse);
    });

    test('actions keep only safe targets', () {
      final surface = decodeSurface(_payload())!;
      expect(surface.actions['ship']!.kind, SurfaceActionKind.run);
      expect(surface.actions['say']!.text, 'Thanks!');
      expect(surface.actions['docs']!.target, isNull);
      expect(surface.actions['site']!.target, isA<SurfaceOpenUrl>());
      expect(surface.actions['big']!.target, isA<SurfaceOpenExpanded>());
    });

    test('not a surface without an id', () {
      expect(decodeSurface(const {'title': 'x'}), isNull);
      expect(decodeSurface('nope'), isNull);
    });
  });

  group('bindings', () {
    test('resolve absolute and relative paths', () {
      final data = {
        'rows': [
          {'name': 'A'},
          {'name': 'B'},
        ],
      };
      expect(
        resolveProp(const {'path': '/rows/1/name'}, data, rootPointer),
        'B',
      );
      expect(resolveProp(const {'path': './name'}, data, ['rows', '0']), 'A');
      expect(
        resolveProp(const {'path': '/missing', 'default': 'x'}, data, const []),
        'x',
      );
      final children = childrenOf(
        const {'template': 'row', 'path': '/rows'},
        data,
        rootPointer,
      );
      expect(children.map((child) => child.key), [
        'row@/rows/0',
        'row@/rows/1',
      ]);
    });

    test('pointers escape and refuse malformed paths', () {
      expect(parsePointer('/a~1b/c~0d'), ['a/b', 'c~d']);
      expect(parsePointer('no-slash'), isNull);
      expect(formatPointer(['a/b', 'c~d']), '/a~1b/c~0d');
    });

    test('visibleWhen follows the catalog', () {
      final data = {'mode': 'edit', 'list': <Object?>[]};
      expect(
        isVisible(
          decodeVisibility(const {'path': '/mode', 'equals': 'edit'}),
          data,
          rootPointer,
        ),
        isTrue,
      );
      expect(
        isVisible(
          decodeVisibility(const {'path': '/list', 'notEmpty': true}),
          data,
          rootPointer,
        ),
        isFalse,
      );
    });
  });

  group('text rules', () {
    test('openableUrl allows https and Kiingo links only', () {
      expect(openableUrl('https://kiingo.com/a'), 'https://kiingo.com/a');
      expect(openableUrl('kiingo://task/1'), 'kiingo://task/1');
      expect(openableUrl('kiingotasks://agent/a'), 'kiingotasks://agent/a');
      // Only routes that show something: never pair, enroll or call.
      expect(openableUrl('kiingo://tasks/1'), isNull);
      expect(openableUrl('kiingolink://pair?code=1'), isNull);
      expect(openableUrl('kiingo://call/1'), isNull);
      // Invisible and bidi characters never reach a link.
      expect(openableUrl('https://kiingo.com/\u202egpj.exe'), isNull);
      expect(openableUrl('https://kiingo.com/a\u200b'), isNull);
      expect(openableUrl('http://kiingo.com'), isNull);
      expect(openableUrl('javascript:alert(1)'), isNull);
      expect(openableUrl('https://user:pw@kiingo.com'), isNull);
      expect(openableUrl(r'https://evil.com\@kiingo.com'), isNull);
      expect(openableUrl('https://a.com/x y'), isNull);
    });

    test('isOutsideUrl confirms everything but the app\'s own origins', () {
      expect(isOutsideUrl('https://app.kiingo.com/x'), isTrue);
      expect(isOutsideUrl('kiingo://task/1'), isTrue);
      expect(isOutsideUrl('https://kiingo.com.evil.io/'), isTrue);
      expect(
        isOutsideUrl(
          'https://app.kiingo.com/x',
          ownOrigins: const ['https://app.kiingo.com'],
        ),
        isFalse,
      );
      expect(
        isOutsideUrl(
          'https://app.kiingo.com:8443/x',
          ownOrigins: const ['https://app.kiingo.com'],
        ),
        isTrue,
      );
    });

    test('asksForSecret matches whole short words', () {
      expect(asksForSecret(['Your password']), isTrue);
      expect(asksForSecret(['Enter the PIN']), isTrue);
      expect(asksForSecret(['Pinned items']), isFalse);
      expect(asksForSecret([null, 'Name']), isFalse);
      // Compared folded and without invisible characters (79 S1).
      expect(asksForSecret(['Your ｐａｓｓｗｏｒｄ']), isTrue);
      expect(asksForSecret(['Your pass\u200bword']), isTrue);
    });

    test('cleanText drops controls and caps length', () {
      expect(cleanText('a\u0007b\u202ec', 10), 'abc');
      expect(
        cleanText('a\u200bb\u061cc\u{E0041}d\ufeffe\u3164f', 10),
        'abcdef',
      );
      expect(cleanText('abcdef', 4), 'abc…');
      expect(cleanText('a\nb', 10), 'a b');
      expect(cleanText('a\nb', 10, lines: true), 'a\nb');
    });
  });

  group('proxiedMediaUrl', () {
    const api = 'https://api.kiingo.com';
    const token = 'abc.DEF_123-~';

    test('accepts the proxy path with one token', () {
      expect(
        proxiedMediaUrl('/api/ui/media?token=$token', api),
        'https://api.kiingo.com/api/ui/media?token=$token',
      );
      expect(
        proxiedMediaUrl(
          'https://api.kiingo.com/api/ui/media?token=$token',
          api,
        ),
        isNotNull,
      );
    });

    test('refuses anything else', () {
      for (final raw in [
        'https://cdn.example.com/api/ui/media?token=$token',
        'https://api.kiingo.com:8443/api/ui/media?token=$token',
        'http://api.kiingo.com/api/ui/media?token=$token',
        '//api.kiingo.com/api/ui/media?token=$token',
        '/api/ui/media?token=$token&x=1',
        '/api/ui/media?token=$token#frag',
        '/api/ui/other?token=$token',
        '/api/ui/media?token=',
        'https://u@api.kiingo.com/api/ui/media?token=$token',
        'data:image/png;base64,AAAA',
      ]) {
        expect(proxiedMediaUrl(raw, api), isNull, reason: raw);
      }
    });

    test('expired statuses re-read the surface', () {
      expect(isExpiredMediaStatus(401), isTrue);
      expect(isExpiredMediaStatus(410), isFalse);
      expect(isExpiredMediaStatus(404), isFalse);
    });
  });

  group('markdown', () {
    test('links open only safe URLs; HTML stays text', () {
      final blocks = parseMarkdown(
        '[ok](https://kiingo.com) [bad](javascript:x) <b>hi</b>',
      );
      final inline = (blocks.single as MdParagraph).children;
      expect(inline.whereType<MdLink>().map((link) => link.href), [
        'https://kiingo.com',
      ]);
      expect(mdInlineText(inline), 'ok bad <b>hi</b>');
    });

    test('snake_case stays literal', () {
      final inline = parseMdInline('a_b_c and _em_');
      expect(inline.whereType<MdSpan>().length, 1);
      expect(mdInlineText(inline), 'a_b_c and em');
    });

    test('lists, headings and quotes', () {
      final blocks = parseMarkdown('# Title\n\n- one\n- two\n\n> said');
      expect(blocks[0], isA<MdHeading>());
      expect((blocks[1] as MdList).items.length, 2);
      expect(blocks[2], isA<MdQuote>());
    });
  });

  test('surfaceDiff marks words added and removed', () {
    final parts = surfaceDiff('the red fox', 'the blue fox');
    expect(
      parts
          .where((part) => part.kind != SurfaceDiffKind.same)
          .map((part) => (part.kind, part.text.trim())),
      [(SurfaceDiffKind.removed, 'red'), (SurfaceDiffKind.added, 'blue')],
    );
  });

  test('editedNote names another client of the person', () {
    final surface = decodeSurface({
      ..._payload()['surface']! as Map<String, Object?>,
      'lastEdit': {'actorKind': 'user', 'client': 'companion_mac'},
    })!;
    expect(editedNote(surface), 'Edited on Mac');
    expect(
      editedNote(surface, ownClient: 'companion_mac'),
      isNull,
      reason: 'own edits are not announced',
    );
  });
}
