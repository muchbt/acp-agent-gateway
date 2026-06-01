import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from "@agentclientprotocol/sdk";

const command = process.env.PROBE_COMMAND;
if (!command) {
  throw new Error("PROBE_COMMAND is required");
}

const args = JSON.parse(process.env.PROBE_ARGS ?? "[]");
const timeoutMs = Number.parseInt(process.env.PROBE_TIMEOUT_MS ?? "90000", 10);
const expectedText = process.env.PROBE_EXPECT_TEXT ?? "smoke-ok";
const skipPrompt = process.env.PROBE_SKIP_PROMPT === "1";
const prompt =
  process.env.PROBE_PROMPT ??
  `Respond with exactly ${expectedText}. Do not use tools.`;
const started = Date.now();
const counts = {};
let text = "";
let closeAdvertised = false;
let closed = false;
let capabilities;
let child;
let timeout;

try {
  child = spawn(command, args, {
    cwd: process.cwd(),
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();
  const client = {
    async requestPermission() {
      return { outcome: { outcome: "cancelled" } };
    },
    async sessionUpdate(params) {
      const updateType = params.update.sessionUpdate;
      counts[updateType] = (counts[updateType] ?? 0) + 1;
      if (
        updateType === "agent_message_chunk" &&
        params.update.content.type === "text"
      ) {
        text += params.update.content.text;
      }
    },
  };
  const connection = new ClientSideConnection(
    () => client,
    ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
  );
  const initialize = await withinTimeout(
    connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "@local/acp-agent-gateway-probe", version: "0.1.0" },
    }),
  );
  closeAdvertised = Boolean(
    initialize.agentCapabilities?.sessionCapabilities?.close,
  );
  capabilities = {
    loadSession: Boolean(initialize.agentCapabilities?.loadSession),
    closeSession: closeAdvertised,
    listSessions: Boolean(
      initialize.agentCapabilities?.sessionCapabilities?.list,
    ),
    resumeSession: Boolean(
      initialize.agentCapabilities?.sessionCapabilities?.resume,
    ),
  };
  const session = await withinTimeout(
    connection.newSession({ cwd: process.cwd(), mcpServers: [] }),
  );
  const result = skipPrompt
    ? undefined
    : await withinTimeout(
        connection.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: prompt }],
        }),
      );
  if (closeAdvertised) {
    await withinTimeout(
      connection.closeSession({ sessionId: session.sessionId }),
    );
    closed = true;
  }
  console.log(
    JSON.stringify({
      status: "completed",
      command,
      durationMs: Date.now() - started,
      ...(result ? { stopReason: result.stopReason } : {}),
      capabilities,
      closeAdvertised,
      closed,
      counts,
      textLength: text.length,
      textMatchesExpected: text === expectedText,
    }),
  );
} catch (error) {
  console.log(
    JSON.stringify({
      status: "failed",
      command,
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : "unknown error",
      ...(capabilities ? { capabilities } : {}),
      closeAdvertised,
      closed,
      counts,
      textLength: text.length,
      textMatchesExpected: text === expectedText,
    }),
  );
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  await terminateChild(child);
}

function withinTimeout(promise) {
  clearTimeout(timeout);
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("probe timeout")), timeoutMs);
    }),
  ]);
}

async function terminateChild(childProcess) {
  if (!childProcess) {
    return;
  }
  if (process.platform === "win32") {
    if (childProcess.exitCode !== null || childProcess.signalCode !== null) {
      return;
    }
    childProcess.kill("SIGTERM");
    await waitForExit(childProcess, 1_000);
  } else {
    signalProcessGroup(childProcess, "SIGTERM");
    if (!(await waitForProcessGroupExit(childProcess, 1_000))) {
      signalProcessGroup(childProcess, "SIGKILL");
    }
  }
  if (childProcess.exitCode === null && childProcess.signalCode === null) {
    childProcess.kill("SIGKILL");
    await waitForExit(childProcess, 1_000);
  }
}

function signalProcessGroup(childProcess, signal) {
  if (childProcess.pid === undefined) {
    return;
  }
  try {
    process.kill(-childProcess.pid, signal);
  } catch {
    // The adapter process group has already exited.
  }
}

function waitForExit(process, durationMs) {
  return new Promise((resolve) => {
    if (process.exitCode !== null || process.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, durationMs);
    process.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitForProcessGroupExit(childProcess, timeoutMs) {
  const started = Date.now();
  while (
    isProcessGroupAlive(childProcess) &&
    Date.now() - started < timeoutMs
  ) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isProcessGroupAlive(childProcess);
}

function isProcessGroupAlive(childProcess) {
  if (childProcess.pid === undefined) {
    return false;
  }
  try {
    process.kill(-childProcess.pid, 0);
    return true;
  } catch {
    return false;
  }
}
