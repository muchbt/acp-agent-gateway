# Keep default events metadata-only

stderr events and ordinary logs will contain metadata-only safe events. They must not include prompt text, Agent final text, environment-variable values, raw ACP payloads, or workspace file contents. Debug mode may write additional diagnostic data only to an explicitly selected file, but it must never weaken credential redaction.
