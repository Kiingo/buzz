# Bare links in messages

Message text that looks like a link is clickable even when the author did not
write a Markdown link. Desktop and mobile follow the same rules, and both run
the same case table: [`test-fixtures/bare-links.json`](../test-fixtures/bare-links.json).

| Text | Becomes | Rule |
|---|---|---|
| `kiingo.com`, `github.com/example/repo/pull/42`, `docs.example.org/a?b=c#d`, `status.example.com:8080/x` | `https://` + the text | A domain with a real TLD, plus an optional port, path, query or fragment |
| `www.example.com` | `https://www.example.com` | Always a link, even with a file-extension TLD |
| `alex@example.com` | `mailto:alex@example.com` | |
| `+1 (555) 123-4567`, `+44 20 7946 0958` | `tel:+15551234567` | `+` and a country code, 8 to 15 digits in all |
| `(555) 123-4567`, `555-123-4567`, `555.123.4567` | `tel:5551234567` | North American formats only |
| `https://…`, `buzz://…` | unchanged | The existing autolinkers own scheme URLs |

Never linked:

- text inside inline code or fenced code;
- text inside an existing link (label or destination), a mention, a channel
  reference, a custom emoji or an entity pill;
- version numbers (`1.2.3`), times (`10:30`), decimals (`3.14`), dates
  (`2026-10-23`), IPv4 addresses, `localhost`, plain digit runs;
- filenames: a bare `name.<tld>` whose TLD is also a common file extension
  (`README.md`, `main.rs`, `setup.py`, `install.sh`, `Buzz.app`,
  `archive.zip`; the list is `fileExtensionTlds` in the case table). It becomes
  a link only with `www.` or a path, query or fragment
  (`linear.app/team/issue/1`). Names whose extension is not a TLD
  (`foo.ts`, `file.dart`, `data.json`) never match a domain at all;
- a domain right after `/`, `@`, `.`, a letter or a digit. A bare link must
  start the text or follow whitespace or one of `( [ { < " ' * _ ~`.

Trailing punctuation (`. , : ; ! ? ' "` and `* _ ~`) is not part of the link,
and neither is a closing `)`, `]` or `}` without a matching opener inside the
link, so `(see kiingo.com)` and `en.wikipedia.org/wiki/Mercury_(planet)` both
work.

## Where it runs

- **Desktop:** `remarkBareLinks` (`desktop/src/shared/lib/remarkBareLinks.ts`)
  runs last among the message remark plugins and calls `findBareLinks`
  (`bareLinks.ts`). Domains are TLD-checked by linkifyjs. The plugin also opens
  GFM's `www.` autolinks over https. `tel:` hrefs of the form above pass the
  Markdown URL transform; the opener plugin's default scope already allows
  `mailto:` and `tel:`.
- **Mobile:** `normalizeBareLinks` (`link_normalizer.dart`) rewrites prose
  outside code into Markdown links using `findBareLinks` (`bare_links.dart`),
  a regex with a TLD allowlist that mirrors desktop. Taps open `mailto:` and
  `tel:` in the system handler.
- **Web:** `web/` does not render message bodies (only invite policy
  documents and repository READMEs), so it has no bare-link pass.

Mobile's TLD allowlist is a subset of linkifyjs's list, so a rare TLD can be a
link on desktop and plain text on mobile. Every case in the shared table uses a
TLD from the allowlist. Link previews still come only from scheme URLs.
