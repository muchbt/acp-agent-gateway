# Store session references outside workspaces

Durable session references will be stored in a user-level state directory, defaulting to `~/.local/state/acp-agent-gateway/sessions/`, with `ACP_AGENT_GATEWAY_STATE_DIR` as an override for CI and isolated environments. Session state must not be written into target workspaces and must not contain tokens, prompts, or Agent final text. Persisted metadata is limited to values needed to locate, validate, and recover a managed session.
