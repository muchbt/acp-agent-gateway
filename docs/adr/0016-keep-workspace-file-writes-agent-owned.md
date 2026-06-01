# Keep workspace file writes Agent-owned

The gateway will not expose a generic filesystem write API. Business artifacts such as PRD documents and debug bundles remain consumer-owned. Durable session references remain gateway-owned and are written outside workspaces. Source edits, generated tests, and formatter changes remain ACP Coding Agent operations under an explicitly selected permission policy. `best-effort-workspace-write` is the standard first-version policy for Agent-driven workspace modifications.

## Consequences

- Consumers write their own business artifacts.
- The gateway writes only its own state outside target workspaces.
- ACP Coding Agents write workspace files when the consumer explicitly selects `best-effort-workspace-write` or a broader policy.
- Reliable filesystem confinement requires future OS sandbox enforcement; ACP permission requests alone are not a strict boundary.
