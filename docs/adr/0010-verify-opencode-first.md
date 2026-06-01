# Verify OpenCode first

The first implementation will register `opencode` as the only verified Agent. `claude` and `codex` remain reserved registry names until their ACP adapters are installed and exercised through compatibility tests. OpenCode is the first target because it exposes ACP support directly, allowing the gateway session core, permissions, events, timeout, and cancellation behavior to be validated before adapter-specific integration work is added.

The built-in OpenCode adapter launches `opencode acp` with the normalized real absolute workspace as the subprocess working directory. ACP session creation receives the same workspace value. The gateway does not also pass OpenCode's optional `--cwd` flag, avoiding a third workspace configuration source.

OpenCode output-shape compatibility and the observed provider stability boundary are recorded in [the OpenCode ACP compatibility report](../compatibility/opencode-acp-1.15.12.md). Verified ACP output compatibility does not remove the need for timeout and failed-run handling.

Phase 2 compatibility validation subsequently enabled Claude and Codex through their controlled Registry entries. Their adapter-specific capability snapshots and observed boundaries are recorded in [the Claude report](../compatibility/claude-agent-acp-0.39.0.md) and [the Codex report](../compatibility/codex-acp-0.15.0.md).
