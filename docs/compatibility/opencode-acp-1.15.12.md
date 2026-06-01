# OpenCode ACP 1.15.12 compatibility report

## Scope

This report records local compatibility validation for OpenCode `1.15.12` through `opencode acp`. The Gateway uses `@agentclientprotocol/sdk` `0.22.1`.

## Findings

- OpenCode advertises standard ACP initialization, session creation, prompt, cancellation, load, list, resume, and close capabilities.
- OpenCode can emit final text as standard `agent_message_chunk` notifications.
- OpenCode may emit `agent_message_chunk` after `session/prompt` returns. The Gateway therefore drains notifications until a short quiet period before returning its Run Result.
- Model behavior is not uniform. Some OpenCode/provider paths complete without final text or remain inactive until the Gateway idle timeout cancels the run.
- Gateway consumers should select an explicitly validated model instead of relying on the OpenCode default model.
- Output compatibility does not imply provider stability. Even the selected smoke model intermittently remained inactive in full Gateway runs.

## Probe results

Prompt: `Respond with exactly smoke-ok. Do not use tools.`

| Model                                                              | ACP probe results                                    | Conclusion                          |
| ------------------------------------------------------------------ | ---------------------------------------------------- | ----------------------------------- |
| OpenCode default (`opencode-go/deepseek-v4-pro` during validation) | 0/3 final texts; 2 idle timeouts; 1 empty completion | Not suitable as an implicit default |
| `opencode-go/deepseek-v4-flash`                                    | 2/3 final texts; 1 idle timeout                      | Intermittent upstream inactivity    |
| `opencode-go/qwen3.6-plus`                                         | 6/6 final texts                                      | Selected for the strict smoke test  |

The direct ACP probe isolates `opencode acp` from Gateway timeout handling. A separate strict end-to-end Gateway smoke sample with `opencode-go/qwen3.6-plus` returned the expected final text in 2/4 runs; the other 2 runs reached the Gateway idle timeout without thought or message notifications. All idle-timeout runs cancelled cleanly.

The Phase 2A stateful Gateway smoke test created one Managed Session, completed two sequential Agent Turns with independent expected text, and closed the Agent-side session through ACP `session/close`. The close-validating smoke sample completed in 1/2 runs; the other run reached the idle timeout during its first Agent Turn and released local resources without reaching close.

The Phase 2B `strict-read-only` sample completed ACP initialization and session creation in 4/4 runs, then reached idle timeout without model text in 4/4 runs. No Bubblewrap filesystem error occurred. Sandbox enforcement is validated separately through deterministic write-boundary tests and successful sandbox-backed Codex and Claude smoke runs.

The probe is intentionally opt-in because it invokes configured models:

```bash
PROBE_MODEL=opencode-go/qwen3.6-plus npm run probe:opencode
SMOKE_REQUIRE_TEXT=1 npm run smoke:opencode
npm run smoke:opencode:stateful
```

## Boundary

The Gateway can prevent truncation of late ACP notifications and can cancel inactive runs. It cannot repair a provider path that produces no final text or no activity. This report validates ACP output compatibility, not a provider availability SLA. Consumers remain responsible for choosing a validated model, configuring timeouts, handling failed runs, and deciding whether an empty Run Result is acceptable for their business workflow.
