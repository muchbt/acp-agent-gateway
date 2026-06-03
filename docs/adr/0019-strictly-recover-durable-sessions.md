# Strictly recover durable sessions

When a Business Consumer recovers a previously persisted Managed Session, the Gateway validates Session Compatibility before attempting any ACP operation. Recovery accepts only a Session Reference; it rejects request-level overrides for Agent Name, Workspace, Permission Policy, and model.

## Consequences

- `resumeSession({ apiVersion, sessionRef })` is the only public recovery surface. Request-level overrides for agent, cwd, permissionPolicy, and model are not accepted.
- The Gateway resolves the stored Agent Name from the controlled Agent Registry and compares the current adapter fingerprint against the persisted fingerprint. A mismatch returns `incompatible_session` and forces either explicit Recovery Fallback or a new session.
- Recovery operations are selected from the intersection of the persisted capability snapshot and the currently advertised capabilities. Capability expansion does not silently enable a recovery operation that was unavailable when the Session Reference was created.
- Recovery rejects records marked `closing` before resolving or launching an adapter. An interrupted Session Close can be cleaned up through `forget()` but cannot silently return to an active recovery path.
- Recovery returns `invalid_session_state` when the persisted record exists but its JSON or schema is invalid. The Gateway preserves corrupted state for diagnosis and explicit `forget()` cleanup instead of reporting the reference as missing.
- Recovery prefers ACP `session/resume`. If `session/resume` is not available in the intersection, it falls back to ACP `session/load`. If neither is available, it returns `unsupported_session_recovery`.
- During `session/load`, the Gateway suppresses Historical Replay from the current Run Event stream and the current Agent Turn text aggregation. Run Event publication begins only after load completion.
- The Gateway probes the current adapter capabilities before opening a recovery session. The probe creates a temporary adapter connection to check capabilities, then terminates the probe process. This avoids modifying the persisted capability snapshot and avoids adapter process leaks when the probe is aborted.
- An explicit `resumeSession({ apiVersion, sessionRef, fallback: "new-session" })` request creates a new durable Managed Session when recovery fails. The result reports `recovery: "fallback-new-session"`, the requested Session Reference, and a new Session Reference. The requested reference is preserved unchanged.
- The Gateway uses `session.adapter` directly during `createSession` persistence rather than re-resolving the adapter from the registry, preventing resource leaks if the registry configuration has changed after the session was opened.
- CLI `resume-session` performs strict recovery only and accepts `--session-ref` without a JSON stdin body. Recovery Fallback remains a TypeScript API operation because creating and immediately releasing an unprompted fallback session is not recoverable across all verified adapters. CLI consumers invoke `start-session` explicitly when they need a new conversation.
