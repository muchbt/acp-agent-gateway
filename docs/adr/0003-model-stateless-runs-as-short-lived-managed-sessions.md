# Model stateless runs as short-lived managed sessions

The gateway will implement every stateless `run()` through the same internal session lifecycle used by future stateful APIs: initialize an ACP connection, create or restore a session, prompt it, collect updates, and release resources. The first public API exposes short-lived runs only, but the internal model retains session identity, advertised Agent capabilities, and lifecycle operations so later stateful and persisted-session features do not require a parallel execution path.

## Consequences

- Phase 1 exposes `run()` while using the shared session core.
- Phase 2 can expose managed session creation, prompting, and closure without changing `run()`.
- Releasing a session terminates local adapter resources without claiming that Agent-side session state was closed. Closing a session calls ACP `session/close` only when advertised; unsupported close returns an explicit error instead of silently degrading to release.
- A Managed Session accepts one in-flight Agent Turn at a time. Each prompt result contains only its current-turn text; the Agent owns conversational context, while consumers own any business history they need to persist.
- Phase 3 can add durable session references and capability-aware recovery without changing consumer request and result envelopes.
- Recovery operations must be selected from Agent-advertised ACP capabilities. The gateway must not assume that every Agent supports session listing, loading, resuming, or closing.
- The existing `v1` stateless Run Result `sessionRef` field predates durable recovery and remains a legacy Run Reference for event correlation only. Stateless runs are not written into the session state store. Durable Managed Sessions receive persisted Session References accepted by recovery operations. A future contract revision should separate `runRef` and `sessionRef` names explicitly.
- Explicit recovery failures return an error by default. A consumer may opt into creating a new session after recovery fails, but the gateway must report that fallback so the consumer cannot mistake the new session for the recovered context.
- Explicit new-session fallback creates a new durable Session Reference and preserves the requested reference unchanged. The result reports `recovery: "fallback-new-session"`, the requested Session Reference, and the new Session Reference.
- Recovery must reject incompatible references by default. The validated user-level persisted record is the source of truth for Agent Name, absolute Workspace, Permission Policy, model, adapter configuration fingerprint, and capability snapshot. Recovery accepts a Session Reference only, rejects request-level overrides, and does not perform implicit session migration. Phase 3 does not add cryptographic integrity protection against the same local user.
- A current adapter fingerprint mismatch returns `incompatible_session`. Recovery operations are selected from the intersection of persisted and currently advertised capabilities, so newly advertised capabilities do not silently change the recovery behavior of an existing Session Reference.
- Recovery prefers ACP `session/resume`, which continues without replaying history. If resume is unsupported but `session/load` is available, the gateway may load the session while suppressing historical replay from the current run's live event stream. If neither capability is available, recovery returns `unsupported_session_recovery`.
