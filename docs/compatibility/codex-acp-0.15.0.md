# Codex ACP 0.15.0 compatibility report

## Scope

This report records local validation for `@zed-industries/codex-acp` `0.15.0`.

## Capabilities

| Capability       | Advertised |
| ---------------- | ---------- |
| `session/load`   | yes        |
| `session/list`   | yes        |
| `session/resume` | no         |
| `session/close`  | yes        |

## Results

- Direct ACP probe returned the expected final text and completed `session/close`.
- Gateway smoke returned the expected final text.
- Gateway smoke returned the expected final text under Linux `strict-read-only`.
- The npm wrapper spawns a native child process. Gateway adapter cleanup therefore terminates the complete adapter process group.

## Phase 3 note

Codex recovery cannot prefer ACP `session/resume` because the adapter does not advertise it. Recovery must use `session/load` and suppress Historical Replay from current Run Events.

## Phase 3 recovery

Codex advertises `session/load` and `session/close` but not `session/resume`. Recovery uses `session/load` and suppresses Historical Replay from the current Run Event stream. The smoke uses `start-session` to create a durable session, execute the first Agent Turn, and release the adapter process atomically before cross-process recovery.

```bash
npm run build
SMOKE_AGENT=codex npm run smoke:recovery:codex
```

| Attempt | start-session | First prompt | Recovery (`session/load`) | Recovered prompt | Close | Replay suppressed? | Result |
| ------- | ------------- | ------------ | ------------------------- | ---------------- | ----- | ------------------ | ------ |
| 1       | pass          | pass         | pass                      | pass             | pass  | pass               | pass   |
| 2       | pass          | pass         | pass                      | pass             | pass  | pass               | pass   |
| 3       | pass          | pass         | pass                      | pass             | pass  | pass               | pass   |

All three attempts completed the full cross-process lifecycle. The `sessionRef` was preserved across processes. Codex restored context through `session/load` and did not leak Historical Replay into the recovered Agent Turn text or stderr Run Events. Replay suppression is also covered by deterministic fake-adapter tests.

The earlier CLI prototype's blank-session failures (where `create-session` released an ACP session without a completed Agent Turn) no longer occur because the public CLI exposes `start-session` instead. It establishes recoverable context before the adapter process exits. This resolved the cross-process blank-session recovery compatibility gap.
