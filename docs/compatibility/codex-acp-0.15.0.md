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
