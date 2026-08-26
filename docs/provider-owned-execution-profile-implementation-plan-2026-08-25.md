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
  generic form sufficient for persistence and later provider deploys.
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
- [x] Ensure later definition snapshot/reconciliation cannot reintroduce the
  invalid desktop-local provider into a provider-owned instance.
- [x] Surface repair/deploy failures honestly and leave the prior authority/data
  intact rather than partially rewriting the record.
- [ ] Prove Ada and every other affected provider-owned agent can be started by
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
- [ ] Add focused E2E coverage for channel attachment and mention startup of a
  repaired provider-owned agent.
- [x] Keep tests focused; add no canary service, permanent smoke-test job, or
  unrelated CI/CD step.

## Resource-safe verification

- [x] Record memory, CPU/load, disk, and largest processes before heavy work.
- [x] Run lightweight format/static/unit checks first with bounded output and
  only one heavy process at a time.
- [ ] Run only the builds/E2E suites required to validate this UI/backend and
  produce the requested Windows installer; do not run broad TypeScript/Jest
  commands gratuitously.
- [x] Re-check host health before each required heavy build and stop after one
  OOM/resource-collapse event rather than looping.
- [x] Record exact commands and green results in this file or the PR evidence.

### Verification evidence before PR

- `cargo fmt --all -- --check`: green.
- `cargo check --tests`: green; only pre-existing unused-code/import warnings.
- Focused Node tests for create mapping/readiness/ownership transitions:
  115 passed, 0 failed.
- `pnpm check:file-sizes`: green; `AgentDefinitionDialog.tsx` remains exactly
  at its upstream line count after extracting provider-mode form/payload logic.
- Biome on all 17 changed/new TypeScript, TSX, and MJS files: green.
- `pnpm build:e2e`: green (`tsc` plus the required E2E Vite bundle).
- `playwright test tests/e2e/where-to-run-config.spec.ts --project=smoke`:
  6 passed, including provider-owned Codex and Claude Code creation with no
  local defaults and serialized-payload assertions.
- `git diff --check`: green.
- A local Rust test-binary link attempt was not repeated after the documented
  host toolchain mismatch (`MSVC 14.33` versus the prebuilt sherpa ONNX C++
  libraries). `cargo check --tests` compiles every Rust test target; required CI
  will run the linked tests on the repository-supported toolchain.

## Delivery, install, and live production proof

- [ ] Commit with sign-off, push the branch, and open a PR referencing this
  checklist and its test evidence.
- [ ] Obtain green required CI without bypassing or weakening any gate.
- [ ] Merge the PR through the normal queue without dequeuing other entries.
- [ ] Verify the merged commit is present on `origin/main`.
- [ ] Build and publish a new unsigned Windows Buzz desktop artifact from the
  merged code using the existing release path.
- [ ] Verify artifact checksum/version/source commit and install the new desktop
  build on this Windows machine with the user's explicit authorization.
- [ ] Launch the installed app and confirm it retains the existing identity,
  community, conversations, and managed-agent inventory.
- [ ] Create a temporary production hosted agent with `Run on: kiingo`, no local
  LLM provider/defaults, a non-empty prompt, and a provider-owned Codex profile;
  confirm creation and a real reply.
- [ ] Repeat the profile selection/provision path with Claude Code (or validate
  against an existing Claude hosted agent if duplicate test infrastructure
  would be wasteful) and confirm the configured model/reasoning values reach
  Kiingo Compute.
- [ ] Add a provider-owned hosted agent to a production channel and confirm it
  deploys without the shared-compute mesh error.
- [ ] Mention that agent in the channel and confirm it starts/replies without
  the shared-compute mesh error.
- [ ] Confirm Ada can be added/mentioned and responds without identity or
  history replacement.
- [ ] Remove only temporary verification agents/messages/resources when safe;
  preserve all pre-existing user data.

## Final audit and cleanup

- [ ] Review the final diff for provider IDs, hidden fallback paths, duplicate
  ownership logic, accidental secrets, oversized core files, and unrelated
  changes.
- [ ] Reconcile every checkbox against concrete evidence; leave nothing checked
  based on intent alone.
- [ ] Confirm production and installed-desktop health after the live proof.
- [ ] Delete the merged remote branch and remove this worktree without touching
  unrelated dirty worktrees.
- [ ] Mark the active goal complete only after every item above is satisfied and
  report the goal tool's final token usage.
