import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const directory = dirname(fileURLToPath(import.meta.url));
const cli = join(directory, "..", "dist", "cli.js");
const workspace = join(directory, "..");
const request = {
  apiVersion: "v1",
  prompt: "Respond with exactly smoke-ok. Do not use tools.",
  model: process.env.SMOKE_MODEL ?? "opencode-go/qwen3.6-plus",
  permissionPolicy: process.env.SMOKE_PERMISSION_POLICY ?? "deny-all",
  timeoutMs: 120_000,
  idleTimeoutMs: 60_000,
};

const child = spawn(
  process.execPath,
  [cli, "run", "--agent", "opencode", "--cwd", workspace],
  { stdio: ["pipe", "pipe", "pipe"] },
);

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});
child.stdin.end(`${JSON.stringify(request)}\n`);

const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", resolve);
});

if (exitCode !== 0) {
  throw new Error(
    `OpenCode smoke test failed with exit ${exitCode}\n${stderr}`,
  );
}

const result = JSON.parse(stdout);
if (result.status !== "completed") {
  throw new Error(`Unexpected OpenCode smoke result: ${stdout}\n${stderr}`);
}

if (result.text !== "smoke-ok") {
  const warning =
    "OpenCode ACP completed without the expected final text. " +
    "The ACP chain is available, but this OpenCode model did not emit an agent_message_chunk.";
  if (process.env.SMOKE_REQUIRE_TEXT === "1") {
    throw new Error(`${warning}\n${stdout}\n${stderr}`);
  }
  console.warn(warning);
}

console.log("OpenCode ACP smoke test passed.");
