import { runRecoverySmokeSuite } from "./smoke-recovery-agent.mjs";

await runRecoverySmokeSuite({
  agent: "codex",
  recoveryOperation: "session/load",
  verifyReplaySuppression: true,
});
