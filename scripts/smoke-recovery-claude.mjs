import { runRecoverySmokeSuite } from "./smoke-recovery-agent.mjs";

await runRecoverySmokeSuite({
  agent: "claude",
  recoveryOperation: "session/resume",
});
