# Integrate business analyzers through the JSON CLI

Business analyzers such as `zentao-story-prd-analyzer` remain separate Business Consumers instead of being vendored into this Gateway repository. They integrate with ACP Agent Gateway through the language-neutral JSON CLI, so the Gateway stays responsible for ACP agent invocation, permissions, events, and session lifecycle while the analyzer keeps owning business prompts, schema validation, evidence checks, generated PRD/ISSUE documents, summaries, and debug bundles.

## Consequences

- The Gateway repository does not take a Python package, Zentao dependency, analyzer business tests, or PRD/ISSUE generation logic.
- Analyzer integrations locate the Gateway executable explicitly, for example through `ACP_AGENT_GATEWAY_BIN`, and otherwise resolve `acp-agent-gateway` from `PATH`.
- Offline consumer packages may provide an `install-gateway.sh` that installs the packed Gateway with npm. When development and testing share the same machine, environment isolation is the caller's responsibility: use `NPM_CONFIG_PREFIX` to isolate npm global installation, or set `ACP_AGENT_GATEWAY_BIN` to a repo-local build such as `node /path/to/acp-agent-gateway/dist/cli.js`.
- The packed Gateway includes its own locked runtime npm dependencies as bundled dependencies, so installing the Gateway tarball offline does not depend on the target machine's npm cache for `@agentclientprotocol/sdk` or `zod`. ACP adapters remain explicit external runtime dependencies.
- Durable session usage remains a consumer workflow decision. A business analyzer may create one durable Managed Session per analyzed item, record the reported Session Reference in its summary and debug bundle, and keep business documents free of Gateway session identifiers.
- Multi-repository business semantics remain analyzer-owned. If an analyzer uses a role-based workspace, it passes that workspace as the Gateway Workspace and validates evidence against its own Target Repository Set.
