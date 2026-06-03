import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist", "cli.js");
const maxAttempts = 3;

export async function runRecoverySmokeSuite({
  agent,
  defaultModel,
  recoveryOperation,
  verifyReplaySuppression = false,
}) {
  if (process.env.SMOKE_AGENT !== agent) {
    throw new Error(`SMOKE_AGENT must be set to ${agent}`);
  }

  const model = process.env.SMOKE_MODEL ?? defaultModel;
  const stateDir = await mkdtemp(
    join(tmpdir(), `acp-agent-gateway-${agent}-recovery-`),
  );
  let passed = false;

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      console.log(`[${agent} recovery] Attempt ${attempt}/${maxAttempts}`);
      try {
        await runRecoveryAttempt({
          agent,
          model,
          recoveryOperation,
          stateDir,
          verifyReplaySuppression,
        });
        passed = true;
        console.log(`[${agent} recovery] Attempt ${attempt} succeeded.`);
        break;
      } catch (error) {
        console.error(
          `[${agent} recovery] Attempt ${attempt} failed: ${errorMessage(error)}`,
        );
      }
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }

  if (!passed) {
    throw new Error(
      `[${agent} recovery] All ${maxAttempts} attempts failed. Diagnose the recorded stage errors before attributing the failure.`,
    );
  }

  console.log(`[${agent} recovery] Smoke test passed.`);
}

async function runRecoveryAttempt({
  agent,
  model,
  recoveryOperation,
  stateDir,
  verifyReplaySuppression,
}) {
  const marker = randomUUID();
  const firstExpected = `first-${marker}`;
  const recoveredExpected = `recovered-${marker}`;
  const startInput = JSON.stringify({
    apiVersion: "v1",
    permissionPolicy: "deny-all",
    ...(model ? { model } : {}),
    prompt: `Remember token ${marker}. Respond with exactly ${firstExpected}. Do not use tools.`,
    timeoutMs: 120_000,
    idleTimeoutMs: 60_000,
  });
  const start = await runCliJson(
    ["start-session", "--agent", agent, "--cwd", root],
    { input: startInput, stateDir },
  );
  assertSessionRef(start.result, "start-session");
  assertCompletedText(start.result, firstExpected, "first prompt");
  assertMetadataOnly(start.stderr, marker, "first prompt stderr");
  console.log(
    `[${agent} recovery] start-session completed: ${start.result.sessionRef}`,
  );
  console.log(`[${agent} recovery] Released session.`);

  const resume = await runCliJson(
    ["resume-session", "--session-ref", start.result.sessionRef],
    { stateDir },
  );
  if (
    resume.result.recovery !== "resumed" ||
    resume.result.sessionRef !== start.result.sessionRef
  ) {
    throw new Error(
      `resume-session did not preserve the Session Reference through ${recoveryOperation}`,
    );
  }
  if (verifyReplaySuppression) {
    assertMetadataOnly(resume.stderr, marker, "resume-session stderr");
  }
  console.log(
    `[${agent} recovery] Recovered session through ${recoveryOperation}.`,
  );

  const secondPrompt = await runCliJson(
    ["prompt", "--session-ref", resume.result.sessionRef],
    {
      input: JSON.stringify({
        prompt:
          "Using the token from the previous turn, respond with exactly recovered-<token>, replacing <token> with that token. Do not use tools.",
        timeoutMs: 120_000,
        idleTimeoutMs: 60_000,
      }),
      stateDir,
    },
  );
  assertCompletedText(secondPrompt.result, recoveredExpected, "second prompt");
  if (verifyReplaySuppression) {
    assertMetadataOnly(secondPrompt.stderr, marker, "second prompt stderr");
  }
  console.log(`[${agent} recovery] Recovered-context prompt passed.`);

  const close = await runCliJson(
    ["close", "--session-ref", resume.result.sessionRef],
    { stateDir },
  );
  if (close.result.closed !== true) {
    throw new Error("close did not report closed=true");
  }
  console.log(`[${agent} recovery] Closed session.`);
}

async function runCliJson(args, options = {}) {
  const execution = await runCli(args, options);
  let result;
  try {
    result = JSON.parse(execution.stdout);
  } catch {
    throw new Error(
      `${args[0]} returned invalid JSON with exit ${execution.exitCode}`,
    );
  }
  if (execution.exitCode !== 0) {
    throw new Error(
      `${args[0]} failed with exit ${execution.exitCode}: ${JSON.stringify(result)}`,
    );
  }
  return { result, stderr: execution.stderr };
}

function runCli(args, options) {
  const env = {
    ...process.env,
    ...(options.stateDir
      ? { ACP_AGENT_GATEWAY_STATE_DIR: options.stateDir }
      : {}),
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    if (options.input !== undefined) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({ exitCode, stderr, stdout: stdout.trim() });
    });
  });
}

function assertSessionRef(result, operation) {
  if (typeof result.sessionRef !== "string") {
    throw new Error(`${operation} did not return a Session Reference`);
  }
}

function assertCompletedText(result, expected, operation) {
  if (result.status !== "completed") {
    throw new Error(
      `${operation} failed: ${result.errorCode ?? "unknown_error"}: ${result.error ?? "missing error message"}`,
    );
  }
  if (result.text !== expected) {
    throw new Error(
      `${operation} returned unexpected text length ${String(result.text ?? "").length}; expected ${expected.length}`,
    );
  }
}

function assertMetadataOnly(stderr, marker, operation) {
  if (stderr.includes(marker)) {
    throw new Error(`${operation} leaked Agent text or Historical Replay`);
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
