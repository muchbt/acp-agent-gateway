# Use Bubblewrap for Linux workspace isolation

Linux sandbox-backed permission policies use Bubblewrap mount namespaces. The gateway mounts the root filesystem read-only, uses an ephemeral `/tmp`, retains network access for model providers, and re-binds Workspace as writable only for `workspace-write`. Registry-declared adapter runtime state directories remain writable because ACP agents may require their own databases and caches; these controlled paths are reviewed as adapter configuration rather than accepted from consumer requests.

## Considered Options

- Rely on ACP permission requests only: portable, but not a filesystem security boundary.
- Use Bubblewrap read-only bind mounts: chosen because it is available as a standalone Linux tool and directly expresses the required writable-root model.
- Use Landlock: retain as a future option when broader kernel and deployment compatibility requirements justify a second backend.
