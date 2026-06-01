import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from "@agentclientprotocol/sdk";

const trials = Number.parseInt(process.env.PROBE_TRIALS ?? "3", 10);
const timeoutMs = Number.parseInt(process.env.PROBE_TIMEOUT_MS ?? "90000", 10);
const drainMs = Number.parseInt(process.env.PROBE_DRAIN_MS ?? "1000", 10);
const model = process.env.PROBE_MODEL;
const prompt = "Respond with exactly smoke-ok. Do not use tools.";

for (let trial = 1; trial <= trials; trial += 1) {
  console.log(JSON.stringify(await probe(trial)));
}

async function probe(trial) {
  const started = Date.now();
  const counts = {};
  let text = "";
  let promptReturnedAt;
  let lastAgentMessageAt;
  let timedOut = false;
  const child = spawn("opencode", ["acp"], {
    cwd: process.cwd(),
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
        lastAgentMessageAt = Date.now();
      }
    },
  };
  const connection = new ClientSideConnection(
    () => client,
    ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
  );
  let sessionId;
  let timeout;

  try {
    await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "@local/acp-agent-gateway-probe", version: "0.1.0" },
    });
    const session = await connection.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });
    sessionId = session.sessionId;
    if (model) {
      await connection.setSessionConfigOption({
        sessionId,
        configId: "model",
        value: model,
      });
    }
    await Promise.race([
      connection.prompt({
        sessionId,
        prompt: [{ type: "text", text: prompt }],
      }),
      new Promise(
        (_, reject) =>
          (timeout = setTimeout(() => {
            timedOut = true;
            reject(new Error("probe timeout"));
          }, timeoutMs)),
      ),
    ]);
    clearTimeout(timeout);
    promptReturnedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, drainMs));
  } catch (error) {
    if (sessionId) {
      await connection.cancel({ sessionId }).catch(() => undefined);
    }
    return result(error instanceof Error ? error.message : "unknown error");
  } finally {
    clearTimeout(timeout);
    child.kill("SIGTERM");
  }

  return result();

  function result(error) {
    return {
      trial,
      status: error ? "failed" : "completed",
      ...(error ? { error } : {}),
      timedOut,
      ...(model ? { model } : {}),
      durationMs: Date.now() - started,
      counts,
      textLength: text.length,
      textMatchesExpected: text === "smoke-ok",
      agentMessageAfterPrompt:
        promptReturnedAt !== undefined &&
        lastAgentMessageAt !== undefined &&
        lastAgentMessageAt > promptReturnedAt,
    };
  }
}
