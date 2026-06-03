# ACP Agent Gateway phased implementation plan

## Objective

Build a reusable TypeScript ACP Agent Gateway that exposes an importable API and a language-neutral JSON CLI. The gateway invokes ACP Coding Agents only. It does not own consumer-specific prompts, business schemas, or generated artifacts.

## Phase 1: Stateless OpenCode gateway

### Public surface

- Initialize npm package `@local/acp-agent-gateway`.
- Require Node.js 24 or newer and publish native ESM only.
- Use TypeScript strict mode, `tsc`, Vitest, ESLint, Prettier, and Zod.
- Define shared Zod schemas for TypeScript API and JSON CLI request and result envelopes.
- Publish the `acp-agent-gateway` executable from the package.
- Export `run(request, options?)`.
- Add `acp-agent-gateway doctor`.
- Add `acp-agent-gateway run --agent opencode --cwd /absolute/path --input request.json`.
- Accept Run Request JSON from a file or stdin only. Do not accept prompt text as a command-line argument.
- Require `apiVersion: "v1"` in JSON CLI input and output.
- Stream JSONL Run Events to CLI stderr and return the final Run Result on stdout.
- Keep stderr events metadata-only: no prompt text, final text, environment values, raw ACP payloads, or workspace file contents.
- Do not add a gateway debug-file mode in Phase 1. Consumers own prompt, final-text, and business diagnostic persistence.

### Internal session core

- Introduce `SessionManager`, `ManagedSession`, and `AdapterTransport`.
- Implement `run()` as `open new session -> prompt -> release`.
- Keep `release()`, `close()`, and `forget()` separate even though only `release()` is needed publicly.
- Retain ACP session ID, capability snapshot, Agent Name, Workspace, Permission Policy, and adapter configuration fingerprint in memory.

### Adapter registry

- Resolve built-in adapters from `PATH` only.
- Register `opencode` as verified.
- Launch OpenCode as `opencode acp` with the normalized real absolute Workspace as subprocess `cwd`, and pass the same Workspace during ACP session creation.
- Reserve `claude` and `codex` names but reject Agent Runs until compatibility-tested.
- Do not download adapters or invoke temporary `npx` installation.

### Permissions and lifecycle

- Implement `best-effort-read-only`, `best-effort-workspace-write`, `approve-all`, and `deny-all`.
- Default to `best-effort-read-only`; require explicit `approve-all`.
- Under `best-effort-read-only`, allow ACP permission requests classified as `read`, `search`, or `think`, and reject `edit`, `delete`, `move`, `execute`, `fetch`, and `other`.
- Use `best-effort-workspace-write` as the standard first-version policy for Agent-driven code changes intended to remain within the selected Workspace.
- Document that ACP permissions are not a strict isolation boundary. Defer OS sandbox-backed `strict-read-only` to a separately designed enhancement.
- Expose interactive approval as a TypeScript API mechanism, not as a Permission Policy. Do not support interactive approval through the machine-oriented JSON CLI.
- Apply absolute Run Timeout and optional Idle Timeout.
- Reset Idle Timeout for every recognized ACP activity.
- Use one cancellation path: ACP cancel, five-second grace period, then process termination.

### Tests

- Unit-test request validation, contract versioning, registry resolution, permissions, event routing, timeout, idle timeout, cancellation, error mapping, and cleanup.
- Integration-test a fake ACP adapter for deterministic lifecycle coverage.
- Add an opt-in OpenCode smoke test for session creation, prompt completion, event streaming, and best-effort write denial.
- Validate OpenCode output compatibility with explicit models and document that consumers should not rely on hidden local defaults.

## Phase 2A: In-process stateful managed sessions

Status: completed.

### Public surface

- Export `createSession()` and expose `prompt()`, `release()`, and `close()` on its returned Managed Session.
- Preserve Phase 1 `run()` as a convenience wrapper over the same session core.
- Keep Phase 2A session state in the owning Gateway process. Durable cross-process recovery remains Phase 3 work.
- Expose Phase 2A stateful operations through the TypeScript API only.
- Keep the Phase 1 JSON CLI surface unchanged: `doctor` and stateless `run`.
- Do not add a daemon or imply cross-process continuation before Phase 3 recovery support exists.
- Define `release()` as local adapter connection and process cleanup without an Agent-side close guarantee.
- Define `close()` as ACP `session/close` followed by local release. Return `unsupported_session_close` instead of silently degrading to `release()` when the Agent does not advertise `sessionCapabilities.close`.
- Return only the current Agent Turn text from `ManagedSession.prompt()`. Do not accumulate conversation text in the Gateway.
- Allow one in-flight Agent Turn per Managed Session. Reject concurrent prompts with `invalid_session_state`.
- Apply timeout, optional idle timeout, cancellation, and grace-period handling independently to each Agent Turn.
- Keep a Managed Session reusable when an Agent Turn cancellation settles within the grace period. Release local resources when cancellation cannot settle cleanly.

### Tests

- Verify multiple prompts reuse one Managed Session.
- Verify release terminates local resources without silently closing Agent-side state.
- Verify close uses ACP `session/close` only when advertised.
- Verify unsupported close returns `unsupported_session_close` and still releases local resources.
- Verify each prompt result contains only its Agent Turn text.
- Verify a cleanly cancelled Agent Turn does not prevent the next prompt.
- Verify `run()` remains a stateless convenience wrapper over the shared session core.

## Phase 2B: OS sandbox policies

Status: completed for Linux with Bubblewrap.

- Design Linux-first OS sandbox enforcement.
- Add sandbox-backed `strict-read-only`.
- Add sandbox-backed `workspace-write`.
- Keep best-effort policies available with explicit semantics.
- Use Bubblewrap read-only bind mounts for the Linux implementation.
- Mount the root filesystem read-only, keep `/tmp` ephemeral, and preserve network access for model providers.
- Keep Workspace read-only under `strict-read-only`; re-bind only Workspace as writable under `workspace-write`.
- Allow only registry-declared adapter runtime state directories as additional writable roots.
- Treat cross-platform sandbox support as a separate design decision.

### Tests

- Verify `strict-read-only` rejects writes inside and outside Workspace.
- Verify `workspace-write` permits writes inside Workspace and rejects writes outside it.
- Verify sandbox-backed policies retain matching ACP permission decisions.

## Phase 2C: Additional adapter compatibility

Status: completed for locally validated Claude and Codex ACP adapters.

- Install and test Claude ACP adapter, then mark `claude` verified.
- Install and test Codex ACP adapter, then mark `codex` verified.
- Record each adapter's capabilities and permission behavior.
- Keep unsupported operations capability-gated.

### Tests

- Run a shared adapter compatibility suite for OpenCode, Claude, and Codex.

## Phase 3: Durable session references and recovery

Status: completed.

### Contract clarification

- Treat the existing Phase 1 `v1` `sessionRef` field on stateless Run Results as a legacy Run Reference used only to correlate Run Events and Run Results.
- Persist and accept Session References only for durable Managed Sessions.
- Do not write Stateless Run references into the session state store.
- Introduce an explicit `runRef` versus `sessionRef` distinction in a future contract revision without silently changing the meaning of existing `v1` fields.

### Session state store

- Add `~/.local/state/acp-agent-gateway/sessions/` storage.
- Support absolute-path `ACP_AGENT_GATEWAY_STATE_DIR` override. Reject relative state directories so separate Gateway processes cannot resolve durable state differently from different working directories.
- Keep `createSession()` ephemeral by default. Persist a Session Reference only when the consumer explicitly selects `durable: true`.
- Keep `run()` stateless and never write its legacy Run Reference into the session state store.
- Retain durable Session References after `release()` so they can be recovered later.
- Delete the durable Session Reference after a successful `close()`.
- Return `session_cleanup_failed` when Agent-side close succeeds but deleting the durable Session Reference fails. Preserve the record for diagnosis and explicit `forget()` cleanup; do not treat it as recoverable context.
- Mark durable records as `closing` before requesting ACP `session/close`. Reject recovery of `closing` records and allow only explicit `forget()` cleanup.
- Define `forget()` as idempotent Gateway state deletion only. It succeeds when the record is already absent and does not claim to close Agent-side state.
- Acquire a local Session Lease before creating, recovering, closing, or forgetting a durable Session Reference. Reject concurrent use with `invalid_session_state`.
- Treat durable state storage as single-host local-filesystem state. Do not support shared NFS state directories or multiple hosts sharing `ACP_AGENT_GATEWAY_STATE_DIR`.
- Return `invalid_session_state` when a persisted record exists but its JSON or schema is invalid. Preserve the file for diagnosis and explicit `forget()` cleanup instead of reporting it as missing.
- Persist only gateway session ID, ACP session ID, Agent Name, absolute Workspace, Permission Policy, configuration fingerprint, capability snapshot, lifecycle state, and timestamps.
- Never persist tokens, prompts, Agent final text, or conversation replay.

### Recovery

- Export `resumeSession()` and `forget()`.
- Validate Session Compatibility before recovery.
- Accept only `apiVersion` and `sessionRef` in `resumeSession()`. Do not accept request-level overrides for Agent Name, Workspace, Permission Policy, or model.
- Read Agent Name, absolute Workspace, Permission Policy, model, adapter configuration fingerprint, and capability snapshot from persisted state.
- Treat validated user-level persisted state as the source of truth for Agent Name, absolute Workspace, Permission Policy, and model. Phase 3 does not add cryptographic integrity protection against the same local user.
- Return `incompatible_session` when the current adapter fingerprint does not match persisted state.
- Select recovery operations from the intersection of persisted and currently advertised capabilities. Capability expansion must not silently enable a recovery operation that was unavailable when the Session Reference was created.
- Keep session migration out of Phase 3. A future migration API requires a separate design.
- Prefer ACP `session/resume`.
- Fall back to `session/load` when supported, while suppressing Historical Replay from current Run Events.
- Return `unsupported_session_recovery` when neither capability exists.
- Return an error by default when recovery fails.
- Allow a new session only through `resumeSession({ sessionRef, fallback: "new-session" })`.
- Generate a new durable Session Reference for fallback sessions. Do not overwrite or delete the requested reference.
- Return `recovery: "fallback-new-session"`, `requestedSessionRef`, and the new `sessionRef` so consumers cannot mistake a new session for recovered context.
- Return `recovery: "resumed"` with the same `sessionRef` after successful recovery.

### Tests

- Verify state store permissions and sensitive-data exclusion.
- Verify strict rejection of request-level Agent Name, Workspace, Permission Policy, and model overrides; schema rejection of invalid persisted values; restoration of persisted values; and adapter fingerprint incompatibility rejection.
- Verify resume preference, load fallback, replay suppression, unsupported recovery, explicit new-session fallback, close, and forget.

## Phase 3 implementation plan

### Phase 3A: Durable session state store

Status: completed.

- Add a `SessionStateStore` abstraction backed by JSON files in `~/.local/state/acp-agent-gateway/sessions/`.
- Support absolute-path `ACP_AGENT_GATEWAY_STATE_DIR` for tests, CI, and isolated deployments. Reject relative explicit and environment-provided state directories.
- Validate persisted state through a versioned Zod schema before use.
- Distinguish missing records from corrupted records. Reject corrupted JSON or schema with `invalid_session_state`, retain the file for diagnosis, and permit explicit `forget()` cleanup.
- Create state directories with user-only permissions and write records atomically through a temporary file plus rename.
- Persist only Session Reference, ACP session ID, Agent Name, normalized absolute Workspace, Permission Policy, selected model, adapter configuration fingerprint, capability snapshot, lifecycle state, and timestamps.
- Add `durable: true` to `createSession()`. Keep default sessions ephemeral and keep `run()` stateless.
- Retain durable records after `release()`.
- Remove durable records after successful `close()`.
- Return `session_cleanup_failed` and retain the record for explicit `forget()` cleanup when Agent-side close succeeds but record deletion fails.
- Persist `closing` before requesting ACP `session/close`; reject recovery of `closing` records so interrupted close paths fail closed.
- Release local adapter resources and the Session Lease when any durable `close()` step fails. If persisting `closing` fails, retain the active record so a new Gateway process can recover it explicitly.
- Acquire an atomic local Session Lease for durable references and release it after local adapter cleanup. Reclaim leases held by dead local PIDs before retrying an operation.
- Serialize stale lease recovery through a short-lived reclaim marker. Fail closed if a reclaim marker remains after an interrupted recovery; the same local user may remove the residual `.reclaim.json` before retrying.
- Use PID-only liveness checks without Linux-specific `/proc` start-time validation. Accept conservative false-positive blocking after rare PID reuse; after confirming no active Gateway owns the reference, the same local user may remove the residual `.lease.json` before retrying.
- Limit the state store to a single host and local filesystem. Shared NFS directories and multi-host `ACP_AGENT_GATEWAY_STATE_DIR` deployments require a separate distributed lease design.
- Export `forget({ apiVersion, sessionRef })` as idempotent Gateway state deletion only. Return success when the record is already absent.

### Phase 3B: Strict recovery

Status: completed.

- Export `resumeSession({ apiVersion, sessionRef })`.
- Load and validate persisted state before launching an adapter.
- Resolve the persisted Agent Name from the controlled Agent Registry and reject adapter fingerprint changes with `incompatible_session`.
- Reuse persisted Workspace, Permission Policy, and model without request-level overrides.
- Select recovery operations from the intersection of the persisted capability snapshot and the current adapter capability snapshot.
- Prefer ACP `session/resume` when currently advertised.
- Fall back to ACP `session/load` when resume is unavailable and load is supported.
- Return `unsupported_session_recovery` when neither operation is available.
- Return recovery errors by default. Do not silently create a new session.

### Phase 3C: Historical Replay suppression and explicit fallback

Status: completed.

- Treat notifications emitted while `session/load` is in progress as Historical Replay.
- Suppress Historical Replay from current Run Events and current Agent Turn text aggregation.
- Start ordinary Run Event publication only after load completes.
- Add `resumeSession({ apiVersion, sessionRef, fallback: "new-session" })`.
- Create a new durable Managed Session and new Session Reference only after recovery fails.
- Preserve the requested Session Reference unchanged.
- Return recovery metadata that distinguishes `resumed` from `fallback-new-session`.

### Phase 3D: CLI and compatibility validation

Status: completed.

- Add JSON CLI commands for atomic durable session start, strict recovery, prompting, close, and forget. Each cross-process command releases the local adapter resources it opens before exiting. Do not expose standalone CLI `create-session` or `release` commands: an unprompted session is not recoverable across all verified adapters, and a new-process release would recover a session only to release the newly opened process. Keep Recovery Fallback in the TypeScript API only; CLI consumers recover strictly and invoke `start-session` explicitly when they need a new conversation.
- Keep stdout reserved for final JSON and stderr for metadata-only JSONL Run Events.
- Add deterministic fake-adapter TypeScript API tests for resume preference, Codex-style load fallback, Historical Replay suppression, unsupported recovery, incompatibility rejection, explicit fallback, close, and forget.
- Add deterministic fake-adapter JSON CLI integration tests for atomic durable session start, prompting, recovery, close, and forget. Verify that stdout remains final-JSON-only and stderr remains metadata-only JSONL.
- Add deterministic state-store tests for user-only directory and record permissions, fail-closed permission tightening, concurrent atomic writes through unique temporary files, and sensitive-data exclusion.
- Add deterministic lease tests for live-holder rejection, stale local PID recovery, ownership-safe release, concurrent stale recovery serialization, Gateway-level concurrent recovery rejection, and cross-process CLI rejection.
- Add opt-in real adapter recovery smoke tests:
  - OpenCode: validate `session/resume`.
  - Claude: validate `session/resume`.
  - Codex: validate `session/load` and Historical Replay suppression.
- Run each real adapter recovery smoke through the JSON CLI so every lifecycle step executes in a separate Gateway process.
- Treat Phase 3D as complete only after every real adapter recovery smoke has run up to three times and completed successfully at least once: create a durable Managed Session, prompt it with a unique context marker, release local resources, recover it from a new Gateway process, prompt it to verify the retained context, and close it. Record every attempt and distinguish provider inactivity from recovery protocol failures.
- For Codex, require the real JSON CLI smoke to verify that `session/load` recovery does not leak first-turn Historical Replay into the recovered Agent Turn text or stderr Run Events. Do not require the real adapter to emit replay notifications. Keep deterministic fake-adapter Vitest coverage that injects replay chunks and verifies their suppression precisely.
- Record adapter-specific recovery results under `docs/compatibility/`.

### Phase 3D completion gate

Phase 3D is complete only when all of the following are true:

- Deterministic fake-adapter TypeScript API, JSON CLI, and state-store tests cover the Phase 3D requirements and pass through `npm run check`.
- OpenCode completes the JSON CLI cross-process recovery smoke through ACP `session/resume` at least once within three attempts. (Completed with OpenCode 1.15.13 and `opencode-go/qwen3.6-plus`.)
- Claude completes the JSON CLI cross-process recovery smoke through ACP `session/resume` at least once within three attempts. (Completed with `claude-agent-acp` 0.39.0, adapter default model, after resolving blank-session recovery gap with `start-session`.)
- Codex completes the JSON CLI cross-process recovery smoke through ACP `session/load` at least once within three attempts and does not leak first-turn Historical Replay into recovered Turn text or stderr Run Events. (Completed with `codex-acp` 0.15.0, adapter default model, after resolving blank-session recovery gap with `start-session`.)
- Every real-adapter attempt is recorded under `docs/compatibility/`, including provider inactivity and recovery protocol failures.

### Blank-session recovery gap (resolved)

Initial recovery smoke attempts using low-level durable session creation → release → cross-process `prompt` failed for Claude and Codex: both adapters returned `Resource not found` when asked to recover a session that had been initialized and configured but had never completed an Agent Turn. The adapter-level conversation state had not been established before the process exited.

The `start-session` CLI command was added to resolve this gap. It atomically creates a durable session, executes the first Agent Turn, and releases the adapter process — ensuring recoverable context exists before cross-process recovery. Claude and Codex both passed subsequent recovery smokes through this atomic execution model.

Low-level durable `createSession({ durable: true })` is retained in the TypeScript API for same-process workflows and instrumentation. Cross-process CLI workflows must use `start-session` for the initial turn and `prompt` for subsequent turns. See ADR 0021 for the full rationale.

## Consumer migration

After Phase 1 is stable, a Python consumer such as `zentao-story-prd-analyzer` can call the Gateway CLI with a business prompt and parse the returned `text`. Its existing business schema validation, evidence checks, document generation, and debug bundle behavior remain consumer-owned.
