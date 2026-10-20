# Agent DM markers

Status: v1, 2026-10-19. Shared contract between agent runtimes that publish into
a 1:1 DM and the desktop and mobile clients that render it. Every marker is an
ordinary signed Nostr tag. Clients that do not know a marker still show the
event's content as a plain message, so each marker degrades to readable text.

All markers below are honoured only in a DM channel (NIP-29 group whose metadata
declares `t=dm` or `hidden`), and only on events signed by a member of that DM.
In any other channel a client renders the event as a plain message from its
signer and applies none of the overrides.

"Quiet" means: the event never makes a channel or thread unread, never counts as
a mention, never raises a DM alert, desktop notification, sound or home-activity
row, and never wakes mobile push. Kind 40002 with no `p` tag already misses
both mobile push filters (`#h` channel subscriptions are kind 9 only; `#p`
self-directed subscriptions need a `p` tag). Quiet events may still advance a
channel's recency ordering.

## 1. Mirrored history: `buzz-mirror`

A message from the same conversation on another surface (an email, a Teams 1:1
message) copied into the DM as history. It is never a reply and never a push.

- Kind `40002`, signed by the agent (the only key that can post into the DM).
- `["h", <channel uuid>]`. No `p` tags. No `e` tags.
- `["buzz-mirror", <surface>, <source_id>, <original_unix_seconds>]`
  - `surface` matches `^[a-z][a-z0-9_-]{0,31}$`. Known values: `email`,
    `teams`, `sms`, `web`, `voice`.
  - `source_id` is opaque (at most 256 characters); it identifies the original
    message on its surface.
  - `original_unix_seconds` is the original message's time.
- `["buzz-mirror-author", <role>, <pubkey or "">, <name or "">]`
  - `role` is `requester` (the person the agent works for) or `agent` (the
    agent's own message on the other surface).
- Optional `["subject", <text>]` (at most 200 characters), for email.
- Content: the message text (markdown).

Rendering:

- `role = agent`: shown as the signer, with a badge.
- `role = requester`: shown as the member whose pubkey is in the tag only when
  that pubkey is 64-hex, differs from the signer, and is a member of this DM.
  Otherwise shown as the signer with the label "Relayed by <signer name>"; a
  claimed name is never displayed as an author.
- Badge: `email` → "via email", `teams` → "via Teams", `sms` → "via SMS",
  `web` → "via web", `voice` → "via voice call", anything else → "via
  <surface>". The tooltip or details
  view gives the original time and, when present, the subject.
- Quiet. Edits, deletion and moderation stay keyed to the signer; the agent
  deletes a mirror with an ordinary kind 5 deletion when the source's retention
  ends.

### Call card: `buzz-call`

One quiet mirror per voice call in the private DM, from the agent: the mirror
tags with surface `voice` (the call id as `source_id`, the call's start as the
time, role `agent`) plus exactly one

- `["buzz-call", <inbound|outbound>, <duration_seconds>, <call_surface>]`
  - `call_surface` matches the surface pattern (`web`, `tasks_ios`,
    `link_ios`, `buzz_huddle`, ...).

Content is the readable fallback, at most 8,000 characters (the transcript's
tail is kept): `Call · N min`, a blank line, the summary, then a blank line,
`Transcript` and the `You:` / `Voice:` / `Agent:` lines.

Rendering: a collapsed card titled from the tag (`Call · N min`, at least one
minute) with the summary; "Show transcript" expands everything after
`Transcript`. A `voice` mirror without `buzz-call` (a spoken reply sent to
chat) is an ordinary mirror badged "via voice call". Quiet like every mirror.

## 2. Session divider: `buzz-session`

The agent's conversation moved to a new native session, or an earlier one was
loaded.

- Kind `40002`, agent-signed, `h` only.
- `["buzz-session", <action>, <session_id or "">]`, where `action` is `new`,
  `load` or `switch` (the conversation continues on another harness).
- Content: one acknowledgement sentence.

Rendering: a full-width divider labelled "New session" (`new`, `switch`) or
"Earlier session loaded" (`load`), with the content as its caption. Quiet.

## 3. Sessions listing: `buzz-sessions`

The agent's answer to a `/sessions` request.

- Kind `40002`, agent-signed, `h` only.
- `["buzz-sessions", <request_event_id or "">]`
- Up to 20 items, newest first:
  `["buzz-session-item", <session_id>, <current|previous>, <started_unix>, <last_active_unix>, <title>, <loadable 1|0>, <turn_count>]`
- Content: the same list as numbered text.

Rendering: a compact list message. Quiet.

### Session commands

Clients send these as ordinary user-signed kind 9 top-level messages in the DM.
The agent runtime treats an exact match (after trimming whitespace) as a
control, not as input to the model, and answers with a divider or a listing:

| Content | Meaning |
|---|---|
| `/sessions` | Ask for a listing. |
| `/new` | End the current session; the next message starts a fresh one. |
| `/sessions load <session_id>` | Resume an earlier session as it was. |
| `/sessions load <session_id> catchup` | The same, with a short catch-up note on the next turn. |

The sessions picker (DM header, 1:1 DMs with an agent only) uses the newest
listing in the DM. When none is under two minutes old it sends `/sessions` and
waits up to 15 seconds for a listing; without one it says the agent did not
answer. "New session" and "Load" ask for confirmation and then send the
command. Errors arrive as the acknowledgement content.

## 4. Question card: `buzz-question`

The agent asks the person a question with options and waits for the answer.

- Kind `9` (a normal agent reply; it notifies and pushes like one).
- `["buzz-question", <ask_id>]`
- 1 to 4 questions, in order:
  `["buzz-question-item", <qid>, <question>, <header or "">, <multi 0|1>, <allow_other 0|1>]`
- 0 to 8 options per question, in order:
  `["buzz-question-option", <qid>, <label>, <description or "">]`
- Content: the questions and options as numbered text, so any client can
  answer by typing.

A later state event closes the card:

- Kind `40002`, agent-signed, quiet, not rendered as a row:
  `["buzz-question-state", <ask_id>, <answered|closed>]`

Answering: a tap sends one user-signed kind 9 top-level message in the DM.

- One question: the content is the chosen label (several labels for a
  multi-select joined by ", "), or the typed "Other" text.
- Several questions: one line per question, `<n>. <answer>`, in question order.
- Tags: `["buzz-answer", <ask_id>]` and, per question,
  `["buzz-answer-item", <qid>, <label>, ...]` or
  `["buzz-answer-other", <qid>, <text>]`. Agent runtimes must not depend on
  these tags; the content alone answers.

The card shows "Answered" after this client sends an answer, or after any
`buzz-answer` message for the ask from the DM's other member, and "Closed"
after a `closed` state event. A closed or answered card no longer accepts taps.

## 5. Action buttons: `buzz-action`

Buttons under an agent message, for example "Retry" or "Continue on another
model" after a visible failure.

- On an agent-signed kind 9 message, up to 3:
  `["buzz-action", <action_id>, <label>, <send_text>, <primary|secondary>, <ref>]`
  - `ref` is an opaque string (at most 512 characters) minted by the agent
    runtime for this exact action.
- A tap sends one user-signed kind 9 top-level message with content
  `send_text` and `["buzz-action-ref", <ref>]`. The agent runtime acts only on
  a ref it minted, from the person it was minted for; typed text without the
  ref is an ordinary message. The button carries no authority of its own.
- After a successful tap the client disables every button on that message.
  The runtime acknowledges an applied action without a chat reply.
