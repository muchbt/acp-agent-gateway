# Claude Agent ACP 0.39.0 compatibility report

## Scope

This report records local validation for `@agentclientprotocol/claude-agent-acp` `0.39.0`.

## Capabilities

| Capability       | Advertised |
| ---------------- | ---------- |
| `session/load`   | yes        |
| `session/list`   | yes        |
| `session/resume` | yes        |
| `session/close`  | yes        |

## Results

- Direct ACP prompt probe returned the expected final text and completed `session/close` in 1/2 runs. The other run reached the probe timeout after session creation.
- Gateway smoke returned the expected final text in 1/3 runs. The other runs reached idle timeout after session creation.
- Gateway smoke returned the expected final text under Linux `strict-read-only`.
- After the `500ms` quiet-period and `empty_response` contract update, a Gateway smoke run returned the expected final text.

## Phase 3 recovery

Claude advertises `session/resume` and `session/close`. The Gateway prefers `session/resume` for recovery. The smoke uses `start-session` to create a durable session, execute the first Agent Turn, and release the adapter process atomically before cross-process recovery.

```bash
npm run build
SMOKE_AGENT=claude npm run smoke:recovery:claude
```

| Attempt | start-session | First prompt | Recovery (`session/resume`) | Recovered prompt      | Close | Result |
| ------- | ------------- | ------------ | --------------------------- | --------------------- | ----- | ------ |
| 1       | pass          | pass         | pass                        | fail (`idle_timeout`) | —     | fail   |
| 2       | pass          | pass         | pass                        | pass                  | pass  | pass   |
| 3       | pass          | pass         | pass                        | pass                  | pass  | pass   |

Attempt 1 succeeded through recovery but the recovered Agent Turn reached idle timeout before producing text. Attempts 2 and 3 completed the full lifecycle including the recovered-context prompt. The `sessionRef` was preserved across processes in all three attempts.

The earlier CLI prototype's blank-session failures (where `create-session` released an ACP session without a completed Agent Turn) no longer occur because the public CLI exposes `start-session` instead. It establishes recoverable context before the adapter process exits. This resolved the cross-process blank-session recovery compatibility gap.

## Boundary

Claude is compatible with the Gateway contract but the observed provider path is intermittent. Consumers must configure timeout and idle timeout and handle failed runs.
