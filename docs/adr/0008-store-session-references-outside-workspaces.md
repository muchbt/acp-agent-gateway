# Store session references outside workspaces

Durable session references will be stored in a user-level state directory, defaulting to `~/.local/state/acp-agent-gateway/sessions/`, with absolute-path `ACP_AGENT_GATEWAY_STATE_DIR` as an override for CI and isolated environments. Relative state directories are rejected so separate Gateway processes cannot resolve durable state differently from different working directories. Session state must not be written into target workspaces and must not contain tokens, prompts, or Agent final text. Persisted metadata is limited to values needed to locate, validate, and recover a managed session.

Persistence is opt-in through `createSession({ durable: true })`. Stateless `run()` and default ephemeral Managed Sessions never write references. Releasing a durable session retains its reference for later recovery. Successfully closing it removes the reference. Forgetting it idempotently removes Gateway-owned state only: it succeeds when the record is already absent and does not claim that Agent-side resources were closed.

Durable records include an `active` or `closing` lifecycle state. Before requesting ACP `session/close`, the Gateway persists `closing`. Recovery rejects `closing` records and permits only explicit `forget()` cleanup, so an interrupted close fails closed. If Agent-side close succeeds but deleting the Gateway record fails, close returns `session_cleanup_failed`; the residual record supports diagnosis without implying recoverable Agent-side context.

Durable state is single-host local-filesystem state. The Gateway acquires a local Session Lease before operating on a durable Session Reference so multiple local processes cannot concurrently recover, prompt, close, or forget the same session. Multiple hosts must not share `ACP_AGENT_GATEWAY_STATE_DIR`; see ADR 0022.

If a record file exists but its JSON or schema is invalid, recovery returns `invalid_session_state` and preserves the file for diagnosis. It is not reported as a missing reference. The same local user may remove Gateway-owned state through explicit `forget()` cleanup.
