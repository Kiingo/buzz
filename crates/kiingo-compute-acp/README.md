# kiingo-compute-acp

`kiingo-compute-acp` is the production ACP adapter between a Buzz agent and
Kiingo Compute. It is intentionally a protocol translator, not an LLM runtime:

- it accepts ACP v2 `initialize`, `session/new`, `session/prompt`, and
  `session/cancel` messages from `buzz-acp`;
- it submits the triggering Buzz event to Kiingo's authenticated canonical
  conversation ingress;
- Kiingo resolves the Buzz author on every prompt and selects that exact
  employee's ChatGPT-backed Codex connection;
- it replays bounded public Compute events over one pooled HTTP client and
  emits ACP updates plus explicit terminal `stopReason` values;
- it sets no provider credential and holds no Buzz private key;
- it requests a fenced publication through ACP, which the parent `buzz-acp`
  process signs locally with the agent's Nostr identity.

The adapter prefers the structured `_meta.buzz` envelope emitted by current
`buzz-acp`. It retains a strict parser for the upstream `format_event_block`
text shape so rolling upgrades remain compatible.

## Required environment

| Variable | Purpose |
| --- | --- |
| `KIINGO_API_BASE_URL` | HTTPS origin for Kiingo API. Loopback HTTP is accepted only for local tests. |
| `BUZZ_BRIDGE_INTERNAL_TOKEN` | Narrow bridge service credential. It is never written to ACP output or logs. |
| `BUZZ_COMMUNITY_ID` | Exact community scope used for identity and receipt checks. |
| `BUZZ_AGENT_PUBLIC_KEY` | 64-character public key of the local Buzz signer. |

Optional bounded tuning:

- `KIINGO_ACP_POLL_INTERVAL_MS` (default `150`, range `50..5000`)
- `KIINGO_ACP_TURN_TIMEOUT_SECS` (default `1800`, range `30..7200`)

The parent must explicitly set
`BUZZ_ACP_KIINGO_PUBLICATION_ENABLED=true`. Without that opt-in,
`buzz-acp` discards custom publication updates. The production agent image
target in the repository Dockerfile selects this executable automatically:

```sh
docker build --target agent-runtime -t buzz-kiingo-agent .
```

Run the focused contract tests with:

```sh
cargo test -p kiingo-compute-acp
```

