# Use local leases for durable session exclusivity

A durable Session Reference can be used by separate Gateway processes. Without coordination, two processes could recover and prompt the same Agent-side session concurrently, or `forget()` could delete state while another process is recovering it.

## Decision

- Acquire a Session Lease before creating, recovering, closing, or forgetting a durable Session Reference.
- Represent the lease as a user-private `${sessionRef}.lease.json` file created atomically with exclusive-create semantics. Store a random lease ID, the local PID, and a timestamp.
- Return `invalid_session_state` while a live local process holds the lease.
- Release only a lease whose random lease ID still matches the current file.
- Reclaim a lease held by a dead local PID before retrying acquisition. Serialize stale recovery through a short-lived `${sessionRef}.reclaim.json` exclusive-create marker so two recovery processes cannot delete each other's replacement lease.
- Fail closed if an interrupted stale recovery leaves a reclaim marker. The same local user may remove the residual `.reclaim.json` file before retrying.
- Use PID-only liveness checks and do not add Linux-specific `/proc` process start-time validation. If the operating system reuses a PID after an abnormal exit, the Gateway conservatively treats the residual lease as live. After confirming no active Gateway owns the reference, the same local user may remove the residual `.lease.json` file before retrying.

## Scope

Session Leases intentionally support one host and a local filesystem only. PID liveness has no cross-host meaning, and shared filesystems do not provide the deployment contract this design assumes. Multiple hosts must not share `ACP_AGENT_GATEWAY_STATE_DIR`, and the state directory must not be placed on NFS or a similar shared filesystem.

A multi-host deployment requires a separately designed distributed lease service with ownership fencing and explicit expiry semantics.
