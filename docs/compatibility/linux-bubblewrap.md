# Linux Bubblewrap compatibility report

## Scope

This report records local validation of Linux sandbox-backed Permission Policies on Ubuntu `22.04.5` under WSL2 with Bubblewrap `0.6.1`.

## Boundary

- Bubblewrap launches the adapter in a mount namespace with the root filesystem read-only.
- `/tmp` is ephemeral and writable.
- Network access remains available for model providers.
- `strict-read-only` keeps Workspace read-only.
- `workspace-write` re-binds only Workspace as writable.
- Agent Registry entries may declare controlled adapter runtime state directories as additional writable roots.

## Results

- Deterministic shell test: `strict-read-only` rejected writes inside and outside Workspace.
- Deterministic shell test: `workspace-write` allowed a write inside Workspace and rejected a write outside Workspace.
- Real Codex ACP Gateway smoke: passed under `strict-read-only`.
- Real Claude ACP Gateway smoke: passed under `strict-read-only`.
- Real OpenCode ACP initialization and session creation: passed under `strict-read-only`; provider inactivity prevented final-text validation in the recorded sample.

## Limitations

The current implementation is Linux-only. Cross-platform sandbox enforcement requires a separate backend decision. Adapter runtime state directories are writable by design and must be reviewed when a new adapter is added.
