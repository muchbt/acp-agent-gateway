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

## Boundary

Claude is compatible with the Gateway contract but the observed provider path is intermittent. Consumers must configure timeout and idle timeout and handle failed runs.
