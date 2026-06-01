#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { stdin, stdout, stderr } from "node:process";
import { API_VERSION, CliRunInputSchema } from "./contracts.js";
import { AcpAgentGateway } from "./gateway.js";
import { AgentRegistry } from "./registry.js";

async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  if (command === "doctor") {
    return doctor(rest);
  }
  if (command === "run") {
    return run(rest);
  }
  writeJson(stderr, {
    apiVersion: API_VERSION,
    status: "failed",
    errorCode: "invalid_request",
    error: "Usage: acp-agent-gateway <doctor|run>",
    durationMs: 0,
  });
  return 2;
}

async function doctor(args: string[]): Promise<number> {
  if (args.length > 0) {
    writeJson(stderr, {
      apiVersion: API_VERSION,
      status: "failed",
      errorCode: "invalid_request",
      error: "doctor does not accept arguments",
      durationMs: 0,
    });
    return 2;
  }
  writeJson(stdout, {
    apiVersion: API_VERSION,
    status: "completed",
    agents: await new AgentRegistry().doctor(),
  });
  return 0;
}

async function run(args: string[]): Promise<number> {
  const parsedArgs = parseRunArgs(args);
  if (!parsedArgs.ok) {
    writeJson(stdout, parsedArgs.error);
    return 2;
  }

  let rawInput: string;
  try {
    rawInput = parsedArgs.input
      ? await readFile(parsedArgs.input, "utf8")
      : await readStdin();
  } catch (error) {
    writeJson(stdout, {
      apiVersion: API_VERSION,
      status: "failed",
      errorCode: "invalid_request",
      error: error instanceof Error ? error.message : "Failed to read input",
      durationMs: 0,
    });
    return 2;
  }

  const input = CliRunInputSchema.safeParse(parseJson(rawInput));
  if (!input.success) {
    writeJson(stdout, {
      apiVersion: API_VERSION,
      status: "failed",
      errorCode: "invalid_request",
      error: input.error.message,
      durationMs: 0,
    });
    return 2;
  }

  const result = await new AcpAgentGateway().run(
    {
      ...input.data,
      agent: parsedArgs.agent,
      cwd: parsedArgs.cwd,
    },
    {
      onEvent: (event) => writeJson(stderr, event),
    },
  );
  writeJson(stdout, result);
  return result.status === "completed" ? 0 : 1;
}

function parseRunArgs(args: string[]):
  | {
      ok: true;
      agent: "opencode" | "claude" | "codex";
      cwd: string;
      input?: string;
    }
  | { ok: false; error: Record<string, unknown> } {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag || !value || !["--agent", "--cwd", "--input"].includes(flag)) {
      return cliArgumentError(
        "run accepts --agent, --cwd, and optional --input",
      );
    }
    values.set(flag, value);
  }
  const agent = values.get("--agent");
  const cwd = values.get("--cwd");
  if (!agent || !["opencode", "claude", "codex"].includes(agent) || !cwd) {
    return cliArgumentError(
      "run requires --agent <name> and --cwd <absolute-path>",
    );
  }
  return {
    ok: true,
    agent: agent as "opencode" | "claude" | "codex",
    cwd,
    ...(values.get("--input") ? { input: values.get("--input") } : {}),
  };
}

function cliArgumentError(error: string) {
  return {
    ok: false as const,
    error: {
      apiVersion: API_VERSION,
      status: "failed",
      errorCode: "invalid_request",
      error,
      durationMs: 0,
    },
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(stream: NodeJS.WritableStream, value: unknown): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    writeJson(stderr, {
      apiVersion: API_VERSION,
      status: "failed",
      errorCode: "internal_error",
      error: error instanceof Error ? error.message : "Unknown CLI error",
      durationMs: 0,
    });
    process.exitCode = 1;
  });
