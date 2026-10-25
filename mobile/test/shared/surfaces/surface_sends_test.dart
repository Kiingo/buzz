import 'dart:io';

import 'package:buzz/shared/surfaces/surface_model.dart';
import 'package:buzz/shared/surfaces/surface_sends.dart';
import 'package:buzz/shared/surfaces/surface_text.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('messageSend', () {
    test('a label that is the words draws and sends it', () {
      final send = messageSend('Thanks!', null);
      expect(send, isA<LabelSend>());
      expect(sentText(send), 'Thanks!');
      expect(sendBlockedText(send), isNull);
    });

    test('words that differ from the label show in full', () {
      final send = messageSend('Approve', 'Yes, approve the plan');
      expect(send, isA<CaptionSend>());
      expect(sentText(send), 'Yes, approve the plan');
      expect(
        sendsCaption('Yes, approve the plan'),
        'Sends: “Yes, approve the plan”',
      );
    });

    test('at most 300 code points are sent, counted as code points', () {
      final emoji = '😀' * sendsMax;
      expect(messageSend('Go', emoji), isA<CaptionSend>());
      final long = messageSend('Go', '${emoji}x');
      expect(long, isA<BlockedSend>());
      expect(sendBlockedText(long), sendsBlockedText);
      expect(messageSend('a' * 301, null), isA<BlockedSend>());
    });

    test('hidden or empty words never send', () {
      expect(
        sendBlockedText(messageSend('Go', 'ok', hidden: true)),
        'Open in Kiingo to send this',
      );
      expect(messageSend('Go', '   '), isA<BlockedSend>());
    });

    test('a slash command is refused, also behind folding or invisibles', () {
      for (final words in ['/approve', '  /x', '／approve', '\u200b/approve']) {
        final send = messageSend('Go', words);
        expect(
          sendBlockedText(send),
          'Slash commands can’t be sent from a card',
        );
      }
    });

    test('only a leading mention of the card\'s own agent is allowed', () {
      expect(
        messageSend('Go', '@Dana do it', agentName: 'Dana'),
        isA<CaptionSend>(),
      );
      expect(messageSend('Go', '@dana', agentName: 'Dana'), isA<CaptionSend>());
      for (final words in ['@Danax hi', '@Dana.bot hi', '@Eve hi', '﹫Eve hi']) {
        expect(
          sendBlockedText(messageSend('Go', words, agentName: 'Dana')),
          'Messages to another agent can’t be sent from a card',
          reason: words,
        );
      }
      expect(messageSend('Go', '@Dana hi'), isA<BlockedSend>());
      expect(
        messageSend('Go', 'mail @Eve later', agentName: 'Dana'),
        isA<CaptionSend>(),
      );
    });
  });

  group('decoded actions and chips', () {
    test('an action with an invisible character in its words is hidden', () {
      final action = decodeAction('a', {
        'kind': 'send_message',
        'label': 'Say thanks',
        'text': 'Thanks\u200b!',
      })!;
      expect(action.hidden, isTrue);
      expect(action.text, 'Thanks!');
      expect(
        messageSend(action.label, action.text, hidden: action.hidden),
        isA<BlockedSend>(),
      );
      final plain = decodeAction('b', {'kind': 'send_message', 'label': 'Hi'})!;
      expect(plain.hidden, isFalse);
    });

    test('a chip shows its label and sends its text', () {
      final chip = chipSend({'text': 'Yes please', 'label': 'Yes'})!;
      expect(chip.label, 'Yes');
      expect(chip.send, isA<CaptionSend>());
      final bare = chipSend({'text': 'Sure'})!;
      expect(bare.label, 'Sure');
      expect(bare.send, isA<LabelSend>());
      expect(chipSend({'label': 'No text'}), isNull);
      final hidden = chipSend({'text': 'Sure', 'label': 'Su\u2060re'})!;
      expect(hidden.send, isA<BlockedSend>());
    });
  });

  group('tap tag', () {
    test('names the card, the control and the revision', () {
      expect(
        buzzSurfaceTapTag(
          const SurfaceTap(
            surfaceId: '0B5C1F7E-8A7D-4D1E-9A51-3C2F1E0D9B88',
            actionId: 'thanks',
            revision: 7,
          ),
        ),
        [
          'buzz-surface-tap',
          '0b5c1f7e-8a7d-4d1e-9a51-3c2f1e0d9b88',
          'thanks',
          '7',
        ],
      );
      expect(chipActionId('chips', 2), 'chip:chips:2');
    });

    test('only the surface card adds it: the composer never carries it', () {
      // Every Dart file that names the tag or builds it.
      final named = <String>[];
      final built = <String>[];
      for (final entity in Directory('lib').listSync(recursive: true)) {
        if (entity is! File || !entity.path.endsWith('.dart')) continue;
        final source = entity.readAsStringSync();
        final path = entity.path.replaceAll(r'\', '/');
        if (source.contains("'buzz-surface-tap'")) named.add(path);
        if (source.contains('buzzSurfaceTapTag(')) built.add(path);
      }
      expect(named, ['lib/shared/surfaces/surface_sends.dart']);
      expect(built..sort(), [
        'lib/features/channels/agent_dm/agent_dm_surface_card.dart',
        'lib/shared/surfaces/surface_sends.dart',
      ]);
    });
  });

  group('compatibility folding', () {
    test('fullwidth, small and mathematical forms read as ASCII', () {
      expect(comparableText('ＡＰＩ　ｋｅｙ'), 'api key');
      expect(comparableText('﹫dana'), '@dana');
      expect(comparableText('𝐩𝐚𝐬𝐬 𝟏𝟐'), 'pass 12');
      expect(hasInvisibleText('a\u{E0020}b'), isTrue);
      expect(hasInvisibleText('plain'), isFalse);
    });
  });

  group('chips draw their words in full (79 M1)', () {
    test('short words are the chip', () {
      final chip = chipSend({'text': 'Sounds good'})!;
      expect(chip.label, 'Sounds good');
      expect(chip.send, isA<LabelSend>());
    });

    test('words too long for one line are drawn under a short label', () {
      final words = 'Yes, approve the plan and send it to the whole team';
      final chip = chipSend({'text': words})!;
      expect(chip.label.runes.length, chipLabelFits);
      expect(chip.label.endsWith('…'), isTrue);
      expect(chip.send, isA<CaptionSend>());
      expect(sentText(chip.send), words);
    });

    test('words on several lines are drawn in full under the first', () {
      final chip = chipSend({'text': 'Yes\nand also this'})!;
      expect(chip.label, 'Yes…');
      expect(sentText(chip.send), 'Yes\nand also this');
      expect(sendBlockedText(chip.send), isNull);
      expect(chip.send, isA<CaptionSend>());
    });

    test('a long label is shortened; its words still show in full', () {
      final chip = chipSend({'text': 'Go', 'label': 'L' * 60})!;
      expect(chip.label.runes.length, chipLabelFits);
      expect(chip.send, isA<CaptionSend>());
    });

    test('too long to show at all still blocks', () {
      expect(chipSend({'text': 'x' * 301})!.send, isA<BlockedSend>());
    });
  });

  group('default-ignorable characters (79 S1)', () {
    test('variation selectors and other ignorables are invisible', () {
      for (final code in [
        0xfe00,
        0xfe0e,
        0xe0100,
        0xe01ef,
        0x034f,
        0x17b4,
        0x17b5,
        0x180b,
        0x180f,
        0x115f,
        0x3164,
      ]) {
        final text = 'Yes${String.fromCharCode(code)}';
        expect(hasInvisibleText(text), isTrue, reason: code.toRadixString(16));
        expect(withoutInvisible(text), 'Yes');
      }
    });

    test('one emoji presentation selector after a pictograph is allowed', () {
      expect(hasInvisibleText('Love it \u2764\uFE0F'), isFalse);
      expect(hasInvisibleText('\u{1F44D}\uFE0F thanks'), isFalse);
      expect(
        messageSend(
          '\u2764\uFE0F',
          null,
          hidden: hasInvisibleText('\u2764\uFE0F'),
        ),
        isA<LabelSend>(),
      );
    });

    test('a run of selectors or a stray one still blocks', () {
      expect(hasInvisibleText('\u2764\uFE0F\uFE0F'), isTrue);
      expect(hasInvisibleText('\u2764\uFE0F\u{E0100}'), isTrue);
      expect(hasInvisibleText('Yes\uFE0F'), isTrue);
      expect(hasInvisibleText('\uFE0F'), isTrue);
      expect(hasInvisibleText('\u2764\uFE0E'), isTrue);
    });
  });

  group('line breaks (79 S2)', () {
    test('three line breaks send; a fourth blocks', () {
      expect(messageSend('Go', 'a\nb\nc\nd'), isA<CaptionSend>());
      expect(
        messageSend('Go', 'a\nb\nc\nd\ne'),
        isA<BlockedSend>().having(
          (send) => send.reason,
          'reason',
          SendBlockedReason.tooLong,
        ),
      );
    });

    test('CRLF counts once; CR, VT, FF, NEL, LS and PS each count', () {
      expect(messageSend('Go', 'a\r\nb\r\nc\r\nd'), isA<CaptionSend>());
      for (final brk in ['\r', '\v', '\f', '\u0085', '\u2028', '\u2029']) {
        expect(
          messageSend('Go', 'a${brk}b${brk}c${brk}d${brk}e'),
          isA<BlockedSend>(),
          reason: brk.codeUnitAt(0).toRadixString(16),
        );
      }
    });

    test('a padded caption cannot hide its tail', () {
      final words = 'Sounds good${'\n' * 280}and also delete it';
      expect(messageSend('Sounds good', words), isA<BlockedSend>());
    });

    test('a slash command still reads as a slash command', () {
      expect(
        messageSend('Go', '/run\n\n\n\n\n'),
        isA<BlockedSend>().having(
          (send) => send.reason,
          'reason',
          SendBlockedReason.slash,
        ),
      );
    });
  });
}
