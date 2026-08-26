# Provider-owned execution profile hard cutover

Active Codex goal: thread `019fac99-df58-7e20-b78a-ffff8fbc8aa2`.

This file is the authoritative completion contract for the provider-owned
execution-profile repair. The work is not complete until every checkbox below
is checked with evidence, the change is merged to `main`, a new unsigned Windows
desktop build is installed, and the live create/channel/mention flows work
against the production Kiingo backend.

## Outcome and invariants

- [x] Treat `config_schema["x-buzz-owns-execution-profile"] === true` from a
  successfully probed `buzz-backend-*` provider as the sole declaration that
  the backend owns harness, model, inference provider, credentials, reasoning,
  and service-tier selection.
- [x] Keep the behavior provider-neutral: no Kiingo provider ID, harness ID,
  model ID, or backend-specific branch in Buzz core/UI logic.
- [x] Fail closed when provider discovery/probing fails, the schema is absent,
  or the ownership declaration is anything other than literal `true`.
- [x] Preserve the existing local-agent and non-owning remote-provider behavior,
  including local runtime/provider/model/credential readiness and the explicit
  refusal to deploy desktop relay-mesh inference remotely.
- [x] Make the cutover durable without feature flags, compatibility shims,
  alternate validation paths, or silent fallback to local/shared compute.
- [x] Preserve agent identity, prompt, relay history, memory, channel
  membership, access policy, and backend configuration while repairing affected
  existing provider-owned agents.

## Baseline and repository safety

- [x] Fetch the latest `origin/main` and base an isolated worktree on commit
  `7cc39f29e243e9a1447a32d8e5b062216f4f1753` without modifying the unrelated
  conflicted canonical checkout.
- [x] Create branch `fix/provider-owned-execution-profile-20260825` in
  `E:\Projects\buzz-kiingo-worktrees\provider-owned-execution-profile-20260825`.
- [x] Confirm the installed signed provider advertises
  `x-buzz-owns-execution-profile: true` and exposes provider-owned Codex/Claude
  execution-profile fields.
- [x] Confirm current create readiness hardcodes provider mode off, so `Run on:
  kiingo` still requires an irrelevant local LLM provider and disables **Add
  agent**.
- [x] Confirm current backend mapping already creates a strict provider backend
  and does not intentionally spawn a local ACP process for remote execution.
- [x] Confirm Ada's definition was persisted with desktop-only
  `provider: relay-mesh`, while Ada's instance is correctly assigned to backend
  provider `kiingo` with a Codex profile.
- [x] Confirm both channel deployment and mention-triggered startup reach the
  same remote deploy guard and fail with the desktop-local mesh-endpoint error.
- [x] Capture pre-change focused test results and resource health before the
  first heavy validation task: 105 focused frontend tests passed; the host had
  64.42 GB free memory (50.4%), 17.7% sampled CPU, and 194.4 GB free on the
  worktree drive.

## Provider capability model

- [x] Add one small, pure, named projection that derives execution-profile
  ownership from the probed provider schema.
- [x] Use that projection everywhere create readiness, rendering, submission,
  and backend intent need the ownership fact; do not duplicate raw schema-key
  access across components.
- [x] Carry the verified ownership fact through the create boundary in a typed,
  generic transient form, then re-probe it at every later provider deploy
  instead of adding a downstream field to Buzz's persisted core agent type.
- [x] Keep provider schema required-field validation authoritative even when the
  provider owns the execution profile.
- [x] Ensure switching back to local or to a non-owning provider immediately
  restores the ordinary local execution-profile requirements.

## Create and edit user experience

- [x] When a selected backend owns the execution profile, remove the local
  **Agent harness**, **LLM provider**, **Model**, local credential, and local
  defaults requirements from the create form.
- [x] Keep the provider-owned controls (for example Codex/Claude harness,
  model mode/selector, reasoning effort, and service tier) in **Run on** and
  block submit until its signed schema's required values are complete.
- [x] Enable **Add agent** once identity/profile fields and provider-owned
  schema fields are valid, even when global local-agent defaults are unset.
- [x] Prevent hidden or auto-seeded local controls from influencing provider-
  owned create validity.
- [x] Make ownership transitions deterministic: no stale hidden validation,
  no erased in-flight provider config, and no misleading local configuration
  summary.
- [x] Preserve definition-edit delta semantics: metadata-only edits do not
  become dependent on current machine readiness, while actual local execution
  changes remain gated.
- [x] Present an actionable user-facing error if a non-owning remote backend is
  paired with desktop-only shared compute instead of allowing an invalid record
  to be created.

## Persistence and execution mapping

- [x] Persist provider-owned definitions/instances without misleading local
  runtime, LLM provider, model, or credential selections.
- [x] Persist the remote provider ID/config and the provider-owned execution
  profile exactly once as the execution authority.
- [x] Ensure provider-owned create does not require an installed local runtime
  and does not resolve or spawn a local ACP command.
- [x] Build provider deploy payloads for provider-owned agents without resolving
  desktop-only model/provider/credential readiness, while retaining identity,
  relay scope, prompt, access policy, timeouts, and signed deployment safety.
- [x] Revalidate provider ownership against the discovered/signed provider at
  the deployment boundary rather than trusting an arbitrary frontend boolean.
- [x] Preserve provider protocol staging, signature validation, bounded I/O,
  redaction, idempotency, tenant/signer scope checks, and policy-pending
  semantics.
- [x] Keep non-owning provider deploy payloads byte/behavior compatible with
  the existing portable local-harness launch contract.

## Existing-agent repair

- [x] Add an idempotent, generic repair for existing provider-owned instances
  that carry the impossible desktop-only `relay-mesh` execution snapshot.
- [x] Determine ownership from the installed provider's validated capability,
  not from provider ID or the shape/value of Kiingo profile fields.
- [x] Clear only the invalid local execution-profile projection; do not rotate
  keys, recreate the agent, delete relay data, change the prompt, or alter
  membership/access/backend config.
- [x] Ensure any later definition snapshot/reconciliation cannot carry the
  invalid desktop-local projection across a provider deploy: the signed
  capability is re-probed and the idempotent repair re-runs under the deploy
  lock before every provider invocation.
- [x] Surface repair/deploy failures honestly and leave the prior authority/data
  intact rather than partially rewriting the record.
- [x] Prove Ada and every other affected provider-owned agent can be started by
  channel attachment and by mention after the repair.

## Contributor contract and focused tests

- [x] Update `desktop/src/features/agents/AGENTS.md` with the generic
  provider-owned execution-profile source, rendering, validation, persistence,
  deploy, and legacy-repair invariants.
- [x] Add pure tests for literal-true ownership, absent/false/malformed schemas,
  required provider config, and local/non-owning transitions.
- [x] Add readiness tests showing provider-owned create bypasses only local
  execution readiness and ordinary create/edit behavior is unchanged.
- [x] Add mapping tests proving provider-owned instances omit local execution
  fields and non-owning/local instances preserve them.
- [x] Add backend tests proving ownership is revalidated, provider-owned deploy
  avoids relay-mesh/local readiness, and non-owning relay-mesh remote deploy is
  still refused.
- [x] Add idempotent repair tests covering linked definitions, definition-less
  instances, safe fields, and no-op cases.
- [x] Add focused desktop E2E coverage for provider-owned create with no global
  defaults/local provider, including Codex and Claude schema selections.
- [x] Add focused E2E coverage for channel attachment and mention startup of a
  provider-owned agent through the ordinary `start_managed_agent` boundary.
- [x] Keep tests focused; add no canary service, permanent smoke-test job, or
  unrelated CI/CD step.

## Resource-safe verification

- [x] Record memory, CPU/load, disk, and largest processes before heavy work.
- [x] Run lightweight format/static/unit checks first with bounded output and
  only one heavy process at a time.
- [x] Run only the builds/E2E suites required to validate this UI/backend and
  produce the requested Windows installer; do not run broad TypeScript/Jest
  commands gratuitously.
- [x] Re-check host health before each required heavy build and stop after one
  OOM/resource-collapse event rather than looping.
- [x] Record exact commands and green results in this file or the PR evidence.

### Verification evidence before PR

- Fork-boundary refactor removed execution ownership from the core persisted
  `BackendKind`; the final divergence is 56 modified upstream files (versus 75
  in the rejected first cut), 36 production files, 2,981 changed production
  lines, 317 hunks, and zero Kiingo business-logic lines in upstream production
  source. `node scripts/check-kiingo-fork-boundary.mjs`: green.

- `cargo fmt --check --manifest-path desktop/src-tauri/Cargo.toml`: green.
- `cargo check --tests`: green; only pre-existing unused-code/import warnings.
- Focused Node tests for create mapping/readiness/ownership transitions:
  115 passed, 0 failed.
- Full desktop Node suite: 5,401 passed; one unchanged `origin/main`
  Windows/JSDOM focus-resume timing test failed because its 10 ms assertion
  window did not span the next animation frame. The feature-focused tests and
  required repository CI remain the acceptance gates for this unrelated
  baseline test.
- `pnpm check:file-sizes`: green; `AgentDefinitionDialog.tsx` remains exactly
  at its upstream line count after extracting provider-mode form/payload logic.
- Biome on all 15 changed/new TypeScript, TSX, and MJS files: green.
- `pnpm build:e2e`: green (`tsc` plus the required E2E Vite bundle).
- `playwright test tests/e2e/provider-owned/where-to-run-config.spec.ts
  --project=smoke`: 3 passed, including provider-owned Codex and Claude Code
  creation with no local defaults, serialized-payload assertions, and channel
  attachment.
- `playwright test tests/e2e/provider-owned/channels.spec.ts --project=smoke`:
  1 passed, proving a channel mention dispatches provider-backed Ada through
  the ordinary managed-agent start boundary.
- `git diff --check`: green.
- A local Rust test-binary link attempt was not repeated after the documented
  host toolchain mismatch (`MSVC 14.33` versus the prebuilt sherpa ONNX C++
  libraries). `cargo check --tests` compiles every Rust test target; required CI
  will run the linked tests on the repository-supported toolchain.

## Delivery, install, and live production proof

- [x] Commit with sign-off, push the branch, and open a PR referencing this
  checklist and its test evidence.
- [x] Obtain green required CI without bypassing or weakening any gate.
- [x] Merge the PR through the normal queue without dequeuing other entries.
- [x] Verify the merged commit is present on `origin/main`.
- [x] Build and publish a new unsigned Windows Buzz desktop artifact from the
  merged code using the existing release path.
- [x] Verify artifact checksum/version/source commit and install the new desktop
  build on this Windows machine with the user's explicit authorization.
- [x] Launch the installed app and confirm it retains the existing identity,
  community, conversations, and managed-agent inventory.
- [x] Create a temporary production hosted agent with `Run on: kiingo`, no local
  LLM provider/defaults, a non-empty prompt, and a provider-owned Codex profile;
  confirm creation and a real reply.
- [x] Repeat the profile selection/provision path with Claude Code (or validate
  against an existing Claude hosted agent if duplicate test infrastructure
  would be wasteful) and confirm the configured model/reasoning values reach
  Kiingo Compute.
- [x] Add a provider-owned hosted agent to a production channel and confirm it
  deploys without the shared-compute mesh error.
- [x] Mention that agent in the channel and confirm it starts/replies without
  the shared-compute mesh error.
- [x] Confirm Ada can be added/mentioned and responds without identity or
  history replacement.
- [x] Remove only temporary verification agents/messages/resources when safe;
  preserve all pre-existing user data.

### Delivery and production evidence

- PR [#103](https://github.com/Kiingo/buzz/pull/103) merged normally at
  `2026-08-26T09:04:41Z`. The tested head was
  `9cd4006a4aad6c6e8e7cb0caadc235501663172c`; merge commit
  `5e3d115a865a6b26eeb5b513700d2daa896b8dd8` is the exact current
  `origin/main` ancestor containing it. No queue entry was dequeued and no gate
  was bypassed.
- Required CI run `32947867876` and CodeQL run `32947863986` are green. The
  one unrelated smoke timing shard was rerun once through the ordinary GitHub
  rerun control and passed as job `98117971391`; Windows Rust, macOS desktop,
  desktop core, all smoke/integration shards, and CodeQL completed successfully.
- Kiingo unsigned artifact workflow run `32951122498` built only Windows from
  the exact merge revision. Artifact `9602089180` is
  `kiingo-buzz-windows-unsigned-5e3d115a865a6b26eeb5b513700d2daa896b8dd8`.
  Its installer is version `0.5.19-kiingo-unsigned.16`, is Authenticode
  `NotSigned`, and has verified SHA-256
  `0924D83CEE18B74D0CEFCDFBF10E4356BECF952664048CAB9184CB60EACE69A5`.
- The verified installer completed with exit code 0 at
  `C:\Users\Ross\AppData\Local\Buzz`. The registered version and installed
  unsigned executable match `0.5.19-kiingo-unsigned.16`; the installed provider
  probes as Kiingo Compute protocol 2/version `0.3.1` and declares literal
  `x-buzz-owns-execution-profile: true`.
- Installed-app readback retained Ross's existing public identity, eleven live
  channels, conversation history, community membership, and the pre-existing
  managed-agent inventory. No identity, conversation, or memory was recreated
  for the provider repair.
- Ada's first installed `start_managed_agent` repaired the persisted record
  from the impossible local `relay-mesh` projection to null local
  provider/model/runtime/command fields, preserved the provider profile and
  public identity, deployed endpoint
  `buzz:2108be13-7463-46c1-8891-5332126ff2a4`, and produced two signed normal
  replies in the existing marketing channel without the mesh error.
- A new temporary Codex agent was created with no local defaults/provider,
  provider-owned automatic model, high reasoning, and a non-empty prompt. Its
  hosted listener built four ACP workers, subscribed to the channel, used the
  warm no-cold-start path, and published a signed semantic reply. A separate
  temporary Claude Code agent did the same; production run
  `2918ce1c-0f7f-479d-95f2-b87f7853686a` proved selected harness
  `claude-code`, Ross's own connected Claude account, and resolved model
  `claude-haiku-4-5`. A normal follow-up produced a signed Claude reply.
- Ellis, Mira, Sage, and High Agency were each passed through the same installed
  provider start boundary. Their hosted listeners each initialized four ACP
  workers and connected to the relay. Disk readback proves all five pre-existing
  provider-owned records now have null local provider/model/runtime/command,
  durable provider endpoint IDs, and no error. One ordinary channel mention
  then produced a signed final reply from each agent; all acceptance messages
  were deleted afterward and High Agency's pre-test channel membership was
  restored.
- Both temporary provider endpoints, listeners, local identities, channel
  memberships, and messages are deleted. The two inert Kiingo core-agent audit
  objects were archived through separate one-time human approvals. Production
  `agents.getAgent` readback proves the Claude record archived at
  `2026-08-26T13:36:37.079Z` and the Codex record archived at
  `2026-08-26T13:35:11.954Z`. No pre-existing user agent, identity, channel,
  conversation, or memory was deleted.

## Final audit and cleanup

- [x] Contain the credential-output diagnostic incident: stop the faulty decode
  path immediately, confirm it wrote no secret to disk or external service, and
  avoid reprinting the exposed values.
- [x] Restore the missing `app.kiingo.com` DNS validation records, complete
  Azure Front Door managed-certificate revalidation, and prove the production
  `/team/buzz` security handoff is reachable before starting the cutover.
- [x] Move Kiingo Compute rollback binaries, release metadata, and download
  staging out of Buzz's live provider-discovery directory; migrate legacy state
  without data loss and prove future provider upgrades expose exactly one
  executable candidate to Buzz.
- [ ] Repair the hosted identity-rotation envelope contract so the verified
  coordinator plan supplies the production-authoritative provider-configuration
  hash, the isolated Buzz rotation extension and Kiingo provider bind every
  replacement envelope to that exact hash, legacy stored plans are enriched
  without exposing configuration or key material, and the current paused
  rotation can resume safely without creating another replacement identity.
- [ ] Rotate the exposed current human and managed-agent Buzz identities through
  the verified hard-cutover workflow, prove continuity/live hosted canaries,
  revoke the prior authorities, and confirm the replacement identities are the
  only active authorities before declaring closure.

- [x] Review the final diff for provider IDs, hidden fallback paths, duplicate
  ownership logic, accidental secrets, oversized core files, and unrelated
  changes.
- [ ] Reconcile every checkbox against concrete evidence; leave nothing checked
  based on intent alone.
- [x] Confirm production and installed-desktop health after the live proof.
- [ ] Delete the merged remote branch and remove this worktree without touching
  unrelated dirty worktrees.
- [ ] Mark the active goal complete only after every item above is satisfied and
  report the goal tool's final token usage.

Kiingo PR `#10707` moved rollback binaries, release metadata, and transient
downloads under `%LOCALAPPDATA%\Buzz\provider-state\kiingo` and added a signed
release-workflow acceptance that performs install, legacy migration, and
rollback against an isolated application-data root. All PR checks passed and
merge `3ed1e458cd5ca6d25293813a9438cd4ee6ab7ea2` was published as signed,
timestamped, provenance-attested provider `0.3.2` by workflow run
`32982872935`. The release checksum matched, the installed release-state record
is `0.3.2`, and Buzz's native discovery/probe boundary now reports exactly one
candidate (`kiingo`), protocol 2, version `0.3.2`, with execution-profile
ownership enabled.

Final implementation-diff audit: the merge changes 30 scoped files (1,506
insertions/370 deletions). Capability detection remains the single literal
`x-buzz-owns-execution-profile` boundary; no provider ID or Kiingo policy was
added to core render/validation logic. The only `relay-mesh` and secret-shaped
values in the implementation diff are explicit regression fixtures and
redaction assertions. The fork-boundary audit remains green with zero Kiingo
business-logic lines in upstream production source, the file-size ratchet is
green, CodeQL is green, and `git diff --check` reports no whitespace errors.

Post-proof production health readback on `2026-08-26` shows Kiingo MCP ready
with no queued jobs and eight effective execution slots. Azure's managed AKS
command path shows both relay replicas and every Buzz supervisor, membership
controller, Kiingo agent, and Redis pod Ready/Running with zero restarts. The
installed desktop remains the exact `0.5.19-kiingo-unsigned.16` release under
`C:\Users\Ross\AppData\Local\Buzz`.

Identity-security prerequisite repair: Azure Front Door's enabled Agent UI
route was intact, but the public `app` CNAME and `_dnsauth.app` TXT record were
missing and the managed certificate had expired. The CNAME now targets the
existing production Front Door endpoint, the fresh validation TXT is present,
Front Door reports domain validation `Approved` and deployment `Succeeded`,
and an ordinary verified-TLS request to `https://app.kiingo.com/` returns 200.
