# Synthesize `empty_response` from late notifications and quiet periods

After an ACP `session/prompt` response completes, the Agent may still emit `agent_message_chunk` notifications that were in flight. The Gateway drains these notifications for a 500 ms quiet period before returning the Run Result. If an Agent Turn completes with `end_turn` but the accumulated text is empty, the Gateway reports `stopReason: "empty_response"` instead of synthesizing an `end_turn` result with no content.

## Consequences

- The Gateway waits 500 ms after the last ACP notification before returning a Run Result. This quiet period catches late-arriving `agent_message_chunk` notifications without introducing excessive latency.
- An Agent Turn that completes with `stopReason: "end_turn"` and empty accumulated text produces `stopReason: "empty_response"`. This distinguishes a genuinely absent response from a protocol error or a non-`end_turn` stop reason with empty text.
- `stopReason: "empty_response"` is a Gateway-synthesized value, not an ACP stop reason. It signals to Business Consumers that the Agent completed its turn without producing any text, regardless of whether late notifications arrived during the quiet period.
- Other stop reasons (`max_tokens`, `max_turn_requests`, `refusal`, `cancelled`) are preserved as-is even when the text is empty. The Gateway does not remap these to `empty_response`.
- The Gateway validates Agent stop reasons against a known enum before mapping. Unknown or unsupported stop reasons produce a `protocol_error` Gateway error rather than being silently passed through.
