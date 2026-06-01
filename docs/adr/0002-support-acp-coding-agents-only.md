# Support ACP Coding Agents only

The gateway will invoke ACP Coding Agents only. It will not expose arbitrary CLI execution, because arbitrary commands do not share ACP session semantics, permission requests, event streams, or result contracts and would turn the gateway into a substantially broader process-execution security boundary.

## Considered Options

- Support arbitrary CLI commands through a generic process wrapper: flexible, but requires a separate security and protocol model.
- Support ACP Coding Agents only: chosen because ACP supplies the common behavioral contract required by the gateway.
