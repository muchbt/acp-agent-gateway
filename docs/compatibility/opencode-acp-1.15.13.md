# OpenCode ACP 1.15.13 compatibility report

## Scope

This report records local compatibility validation for OpenCode `1.15.13` through `opencode acp`. The Gateway uses `@agentclientprotocol/sdk` `0.22.1`.

## Capabilities

OpenCode advertises standard ACP initialization, session creation, prompt, cancellation, `session/resume`, `session/list`, and `session/close`.

## Phase 3 recovery

OpenCode advertises `session/resume`. Recovery uses `start-session` to create a durable session, execute the first Agent Turn, and release the adapter process atomically — establishing recoverable context before cross-process recovery.

```bash
npm run build
SMOKE_AGENT=opencode SMOKE_MODEL=opencode-go/qwen3.6-plus npm run smoke:recovery:opencode
```

| Attempt | start-session | First prompt | Recovery (`session/resume`) | Recovered prompt | Close | Result |
| ------- | ------------- | ------------ | --------------------------- | ---------------- | ----- | ------ |
| 1       | pass          | pass         | pass                        | pass             | pass  | pass   |

The first Agent Turn established recoverable context through `start-session`. The recovered turn retrieved the first-turn token and produced the expected marker-embedded response. The `sessionRef` was preserved across processes.

## Boundary

This report validates the ACP recovery contract and cross-process `sessionRef` preservation. Provider text stability and latency are not evaluated by the recovery smoke.

The recovery smoke used `deny-all` permission policy and was not run inside the Gateway Bubblewrap sandbox. OpenCode requires writable runtime state for SQLite, which is incompatible with the outer tool sandbox used in some CI environments. The Gateway Bubblewrap sandbox compatibility is tracked separately under `docs/compatibility/linux-bubblewrap.md`.
