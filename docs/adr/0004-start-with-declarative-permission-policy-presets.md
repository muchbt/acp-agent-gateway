# Start with declarative permission policy presets

The first public API will accept declarative permission policy presets only: `best-effort-read-only`, `best-effort-workspace-write`, `approve-all`, and `deny-all`. `best-effort-read-only` is the default. It automatically permits ACP tool calls classified as `read`, `search`, or `think`, and rejects `edit`, `delete`, `move`, `execute`, `fetch`, and `other`. `best-effort-workspace-write` is the standard first-version policy for Agent-driven code changes intended to remain within the selected workspace. `approve-all` must always be selected explicitly and must never become an adapter default or an implicit fallback during recovery. Arbitrary consumer callbacks and custom rules are deferred until the preset semantics are stable across supported ACP agents.

ACP Agents may perform tool calls without requesting Client permission, and ACP tool-call kinds are classification hints rather than an operating-system security boundary. The first version therefore does not claim strict read-only isolation or strict workspace confinement. Later `strict-read-only` and `workspace-write` policies require a separate OS sandbox design.

Interactive approval is a TypeScript API mechanism, not a permission policy preset. The JSON CLI is a machine-oriented boundary with stdout reserved for final JSON and stderr reserved for JSONL events, so it does not support interactive approval. A future interactive TTY mode requires a separate design.

## Considered Options

- Accept arbitrary callbacks immediately: flexible, but difficult to represent through the JSON CLI and easy to make inconsistent across consumers.
- Provide declarative presets first: chosen because TypeScript imports and language-neutral JSON CLI calls can share the same auditable contract.
