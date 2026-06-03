import { runRecoverySmokeSuite } from "./smoke-recovery-agent.mjs";

await runRecoverySmokeSuite({
  agent: "opencode",
  defaultModel: "opencode-go/qwen3.6-plus",
  recoveryOperation: "session/resume",
});
