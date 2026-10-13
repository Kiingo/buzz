# Provider preflight and failed-create rollback

This extends provider protocol v2 (see
[provider-confirmed-delete.md](provider-confirmed-delete.md)) with two narrow
additions for the create flow. Without them, a remote create could fail
late with a reason the owner could have fixed first, such as a disconnected
subscription, and leave a half-created agent behind.

## `preflight`: owner readiness before create

A provider may advertise `preflight` with
`capabilities.lifecycle_operations: ["delete", "preflight"]`. The entries must
be a subset of `delete` and `preflight` with no duplicates. Anything else still
rejects the provider. Desktops released before this change reject a provider
that advertises `preflight`, so a provider should advertise it only once the
desktops it ships with accept it. A provider bundled inside the app always ships
with a matching desktop.

The desktop sends:

- `op: "preflight"`
- a fresh UUID request ID
- `provider_config`, the same flat, validated configuration that deploy would
  send
- a short-lived owner proof: kind 27236, content `buzz-provider-preflight-v1`,
  with exactly five two-value tags in this order: `action=preflight`,
  `provider`, `request`, `community` and `expires` (at most five minutes ahead)

The only accepted response is an object whose keys are a subset of:

| Field | Rule |
| --- | --- |
| `ok` | must be `true` |
| `ready` | boolean, required |
| `message` | optional text, at most 300 characters, no control characters |
| `notice` | optional text, same limits; one plain line shown under the fields |
| `action_label` | optional text, at most 40 characters; dropped when there is no URL |
| `action_url` | optional `https` URL with a host and no userinfo, at most 2048 characters |

Any other key, a non-boolean `ready`, or out-of-bounds text rejects the whole
response. A provider therefore cannot place arbitrary content or links in the
create dialog.

Preflight must be read-only: it creates, changes and reserves nothing. The
dialog runs it whenever the configuration settles, again when the window regains
focus (the owner may have just connected a subscription in the browser), and on
**Check again**. Create stays blocked until a check of the *current*
configuration returns `ready: true`. While a check is running, or after an error,
Create fails closed. Providers that do not advertise `preflight` never block.

## `remote_state` on deploy failure

A failed deploy (`ok: false`) may include `remote_state: "absent"`. With it, the
provider asserts that no remote agent exists for this agent identity. Any other
value, a missing field, a timeout, a crash or a local failure before the
provider answers all leave remote state **unknown**. Only the exact string
`"absent"` counts.

## Rolling back a failed create

When a provider-backed create does not start, the desktop undoes it instead of
keeping a broken agent:

1. If the record has a provider agent ID, confirmed delete removes it.
2. Otherwise the outcome is unknown. The desktop replays the identical deploy
   once; a provider whose deploy is idempotent returns the existing agent ID, or
   creates the agent now.
   - On success, confirmed delete removes the agent.
   - On a failure carrying `remote_state: "absent"`, local cleanup alone is
     enough.
   - On any other failure, nothing is removed.
3. The definition created in the same flow is deleted only after its agent is
   gone.

The local record and agent key are removed only after the provider confirmed
deletion or absence. Local cleanup is never treated as proof that the remote
agent is gone. When the outcome stays unknown, the dialog keeps the record and
says so; the next attempt retries the cleanup before creating anything new.
Rollback is idempotent: an already removed agent reports success.

## Build-preferred destination

A distribution that bundles its own provider can set
`VITE_BUZZ_PREFERRED_RUN_ON` at build time to that provider's ID. When that
provider is discovered, the create form:

- leads with **Where it runs**;
- offers exactly that destination (the default) and this computer;
- prefills a name and instructions.

A provider inside the app's own macOS bundle (`.app/Contents/MacOS`) gets a
plain note in place of the untrusted-binary warning. Builds that do not set the
variable are unchanged. Provider schemas may mark bookkeeping fields with
`"x-hidden": true`; these are sent with their defaults and are never rendered.
