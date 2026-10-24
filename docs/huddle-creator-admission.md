# Creator-admitted huddles

A huddle's backing channel (a private, TTL-bound kind:9007 channel) is
*creator-admitted* when its kind:9007 carries
`["admission", "creator", "<parent channel id>"]`. The relay reads the mark
from the stored creation event, so it is fixed for the channel's lifetime.

## Rules on a marked channel

- No kind:9002 may add, change or clear the mark, or change visibility.
- Only the creator publishes kind:9000 (put) and kind:9001 (remove). A put
  needs a target that is an active member of the parent channel. Members
  leave with kind:9022. Parent owners and admins may still delete the
  channel with kind:9008.
- Audio admits the creator and the members the creator put, while they stay
  active members of the parent. The parent auto-add and open-visibility
  shortcut do not apply, and an expired channel admits nobody.
- The audio re-check applies the same rule every tick. A mark that cannot be
  read is retried each tick; after three consecutive unreadable ticks the
  member's audio is disconnected. Admission is checked again after the
  socket is bound, so a removal that lands between the admission check and
  registration still drops the socket.
- A kind:9001 or kind:9022 is acknowledged once the member's local audio
  socket has closed and the end has been published to the other relay pods.
  "Confirmed" means that publish and the local close; it does not wait for
  remote pods to close their sockets. When the local close is not confirmed
  within 2 s, the relay force-drops the socket and answers `OK` true with
  `warning: live audio close not confirmed`, which callers treat as not
  acknowledged.
- Puts may carry opaque `call` and `epoch` tags, echoed in the kind:39002
  roster as `["put", <member>, <call>, <epoch>]`.

The creator may still change the channel TTL with kind:9002. This is
accepted: the creator is the party that runs the huddle.

## Huddle service identities

`BUZZ_HUDDLE_SERVICE_PUBKEYS` lists keys that run creator-admitted huddles on
behalf of a server. NIP-11 advertises them as `huddle_service_pubkeys`.

A service identity is not a member of anything. It has no relay membership,
gets no member row on the channels it creates, and appears in no roster or
directory. It is not invisible: its events are signed and stored like any
other, and clients render its huddle notices as system notices rather than
as a person.

It authenticates only with NIP-98 (kind:27235) on `POST /events`. WebSocket
AUTH, audio, and every other HTTP route refuse it. It submits only events it
signed, and no other key may submit its events (gift wraps included). Through
that route it may publish only:

| Kind | Allowed when |
|------|--------------|
| 9007 | A private, TTL-bound channel with exactly the 3-element admission mark naming a live parent. The service need not belong to the parent. |
| 9000 | The channel is marked and the service created it; the target is an active parent member, re-checked at admission; the role is `member`. |
| 9001 | The channel is marked and the service created it. |
| 9008 | The channel is marked and the service created it. |
| 48100 | Its only tag is `h` = the parent, its content is exactly `{"ephemeral_channel_id": <backing channel>}`, the service created that backing channel and its mark names this parent, and no start or end exists yet for it. |
| 48103 | Same shape, after exactly one start and before any end. |

Every other kind is refused, including messages, reactions, edits, typing
and any parent membership or role change. The relay never admits a service
key to huddle audio.
