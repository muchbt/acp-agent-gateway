import { run } from "../dist/index.js";

const agent = process.env.SMOKE_AGENT;
if (!agent) {
  throw new Error("SMOKE_AGENT is required");
}

const result = await run({
  apiVersion: "v1",
  agent,
  cwd: process.cwd(),
  ...(process.env.SMOKE_MODEL ? { model: process.env.SMOKE_MODEL } : {}),
  prompt: "Respond with exactly smoke-ok. Do not use tools.",
  permissionPolicy: process.env.SMOKE_PERMISSION_POLICY ?? "deny-all",
  timeoutMs: 180_000,
  idleTimeoutMs: 120_000,
});

if (result.status !== "completed" || result.text !== "smoke-ok") {
  throw new Error(`Unexpected ACP smoke result: ${JSON.stringify(result)}`);
}

console.log(`${agent} ACP smoke test passed.`);
