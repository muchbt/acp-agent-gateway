# Distinguish best-effort from sandbox-backed policies

The gateway exposes both ACP-decision-only best-effort policies and Linux Bubblewrap-backed policies. `best-effort-read-only` and `best-effort-workspace-write` classify ACP permission requests but do not claim filesystem confinement. `strict-read-only` mounts the root filesystem and Workspace read-only. `workspace-write` keeps the root filesystem read-only and re-binds only Workspace as writable.

Sandbox-backed policies retain network access for model providers, mount an ephemeral `/tmp`, and permit registry-declared adapter runtime state directories as additional writable roots. Those paths are controlled adapter configuration, not consumer-selected Workspace paths. New adapters must document and review any required writable state directories before being marked verified.
