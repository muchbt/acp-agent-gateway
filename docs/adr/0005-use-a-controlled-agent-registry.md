# Use a controlled Agent registry

The gateway will resolve stable Agent names such as `claude`, `codex`, and `opencode` through a controlled Agent registry. Consumer requests must not provide adapter launch commands. Request-level commands would bypass the ACP-only boundary and expand the gateway into an arbitrary process execution surface. A later version may support administrator-maintained configuration files without changing the consumer request contract.
