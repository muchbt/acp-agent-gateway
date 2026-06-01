import { createSession } from "../dist/index.js";

const session = await createSession({
  apiVersion: "v1",
  agent: "opencode",
  cwd: process.cwd(),
  model: process.env.SMOKE_MODEL ?? "opencode-go/qwen3.6-plus",
  permissionPolicy: process.env.SMOKE_PERMISSION_POLICY ?? "deny-all",
  timeoutMs: 120_000,
  idleTimeoutMs: 60_000,
});
let closed = false;

try {
  await expectText(
    session.prompt({
      prompt: "Respond with exactly first-ok. Do not use tools.",
      timeoutMs: 120_000,
      idleTimeoutMs: 60_000,
    }),
    "first-ok",
  );
  await expectText(
    session.prompt({
      prompt: "Respond with exactly second-ok. Do not use tools.",
      timeoutMs: 120_000,
      idleTimeoutMs: 60_000,
    }),
    "second-ok",
  );
  await session.close();
  closed = true;
} finally {
  if (!closed) {
    await session.release();
  }
}

console.log("OpenCode ACP stateful smoke test passed.");

async function expectText(resultPromise, expected) {
  const result = await resultPromise;
  if (result.status !== "completed" || result.text !== expected) {
    throw new Error(
      `Unexpected OpenCode stateful smoke result: ${JSON.stringify(result)}`,
    );
  }
}
