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

### Session state store

- Add `~/.local/state/acp-agent-gateway/sessions/` storage.
- Support `ACP_AGENT_GATEWAY_STATE_DIR` override.
- Persist only gateway session ID, ACP session ID, Agent Name, absolute Workspace, Permission Policy, configuration fingerprint, capability snapshot, and timestamps.
- Never persist tokens, prompts, Agent final text, or conversation replay.

### Recovery

- Export `resumeSession()` and `forget()`.
- Validate Session Compatibility before recovery.
- Prefer ACP `session/resume`.
- Fall back to `session/load` when supported, while suppressing Historical Replay from current Run Events.
- Return `unsupported_session_recovery` when neither capability exists.
- Return an error by default when recovery fails.
- Allow a new session only through an explicit fallback option and report that fallback in the result.

### Tests

- Verify state store permissions and sensitive-data exclusion.
- Verify incompatible Agent Name, Workspace, Permission Policy, and configuration fingerprint rejection.
- Verify resume preference, load fallback, replay suppression, unsupported recovery, explicit new-session fallback, close, and forget.

## Consumer migration

After Phase 1 is stable, a Python consumer such as `zentao-story-prd-analyzer` can call the Gateway CLI with a business prompt and parse the returned `text`. Its existing business schema validation, evidence checks, document generation, and debug bundle behavior remain consumer-owned.
