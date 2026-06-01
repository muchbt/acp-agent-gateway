# Require explicit adapter installation

ACP adapters must be installed explicitly by users or environment administrators. The gateway will provide a `doctor` command that detects available adapters and reports missing components with installation instructions, but Agent runs must not silently download packages or trigger temporary `npx` installation. This keeps dependency versions, supply-chain review, offline behavior, and failure timing predictable.

The first version resolves built-in adapter executables from `PATH` only. Request-level and environment-variable path overrides are not accepted. A later administrator-maintained configuration file may add controlled absolute-path overrides and include them in the adapter configuration fingerprint.
