#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { stdin, stdout, stderr } from "node:process";
import {
  API_VERSION,
  CliRunInputSchema,
  PromptRequestSchema,
} from "./contracts.js";
import { GatewayError } from "./errors.js";
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
  if (command === "start-session") {
    return startSession(rest);
  }
  if (command === "resume-session") {
    return resumeSession(rest);
  }
  if (command === "prompt") {
    return prompt(rest);
  }
  if (command === "close") {
    return close(rest);
  }
  if (command === "forget") {
    return forget(rest);
  }
  writeJson(stderr, {
    apiVersion: API_VERSION,
    status: "failed",
    errorCode: "invalid_request",
    error:
      "Usage: acp-agent-gateway <doctor|run|start-session|resume-session|prompt|close|forget>",
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
  const parsedArgs = parseAgentCwdArgs(args, "run");
  if (!parsedArgs.ok) {
    writeJson(stdout, parsedArgs.error);
    return 2;
  }

  const rawInput = await readInput(parsedArgs.input);
  if (typeof rawInput !== "string") {
    writeJson(stdout, rawInput);
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

async function startSession(args: string[]): Promise<number> {
  const parsedArgs = parseAgentCwdArgs(args, "start-session");
  if (!parsedArgs.ok) {
    writeJson(stdout, parsedArgs.error);
    return 2;
  }

  const rawInput = await readInput(parsedArgs.input);
  if (typeof rawInput !== "string") {
    writeJson(stdout, rawInput);
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

  try {
    const gateway = new AcpAgentGateway();
    const session = await gateway.createSession(
      {
        apiVersion: input.data.apiVersion,
        model: input.data.model,
        permissionPolicy: input.data.permissionPolicy,
        timeoutMs: input.data.timeoutMs,
        idleTimeoutMs: input.data.idleTimeoutMs,
        agent: parsedArgs.agent,
        cwd: parsedArgs.cwd,
        durable: true,
      },
      {
        onEvent: (event) => writeJson(stderr, event),
      },
    );
    const sessionRef = session.sessionRef;
    let result;
    try {
      result = await session.prompt(
        {
          prompt: input.data.prompt,
          timeoutMs: input.data.timeoutMs,
          idleTimeoutMs: input.data.idleTimeoutMs,
          gracePeriodMs: input.data.gracePeriodMs,
          includeEvents: input.data.includeEvents,
        },
        {
          onEvent: (event) => writeJson(stderr, event),
        },
      );
    } catch (promptError) {
      await cleanupFailedStartSession(
        gateway,
        session,
        sessionRef,
        parsedArgs.agent,
      );
      writeJson(stdout, {
        ...errorResponse(promptError),
        sessionRef,
      });
      return 1;
    }

    if (result.status !== "completed") {
      await cleanupFailedStartSession(
        gateway,
        session,
        sessionRef,
        parsedArgs.agent,
      );
    } else {
      try {
        await session.release();
      } catch (releaseError) {
        writeJson(stdout, {
          ...errorResponse(releaseError),
          sessionRef,
        });
        return 1;
      }
    }
    writeJson(stdout, {
      ...result,
      sessionRef,
    });
    return result.status === "completed" ? 0 : 1;
  } catch (error) {
    writeJson(stdout, errorResponse(error));
    return 1;
  }
}

async function resumeSession(args: string[]): Promise<number> {
  const sessionRef = parseSessionRefArg(args);
  if (typeof sessionRef !== "string") {
    writeJson(stdout, sessionRef);
    return 2;
  }

  try {
    const result = await new AcpAgentGateway().resumeSession(
      {
        apiVersion: API_VERSION,
        sessionRef,
      },
      {
        onEvent: (event) => writeJson(stderr, event),
      },
    );
    await result.session.release();
    writeJson(stdout, {
      apiVersion: API_VERSION,
      sessionRef: result.session.sessionRef,
      recovery: result.recovery,
      ...(result.requestedSessionRef
        ? { requestedSessionRef: result.requestedSessionRef }
        : {}),
    });
    return 0;
  } catch (error) {
    writeJson(stdout, errorResponse(error));
    return 1;
  }
}

async function prompt(args: string[]): Promise<number> {
  const sessionRef = parseSessionRefArg(args);
  if (typeof sessionRef !== "string") {
    writeJson(stdout, sessionRef);
    return 2;
  }

  const rawInput = await readInput();
  if (typeof rawInput !== "string") {
    writeJson(stdout, rawInput);
    return 2;
  }

  const input = PromptRequestSchema.safeParse(parseJson(rawInput));
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

  try {
    const { session } = await new AcpAgentGateway().resumeSession({
      apiVersion: API_VERSION,
      sessionRef,
    });
    try {
      const result = await session.prompt(input.data, {
        onEvent: (event) => writeJson(stderr, event),
      });
      await session.release();
      writeJson(stdout, result);
      return result.status === "completed" ? 0 : 1;
    } finally {
      await session.release();
    }
  } catch (error) {
    writeJson(stdout, errorResponse(error));
    return 1;
  }
}

async function close(args: string[]): Promise<number> {
  const sessionRef = parseSessionRefArg(args);
  if (typeof sessionRef !== "string") {
    writeJson(stdout, sessionRef);
    return 2;
  }

  try {
    const { session } = await new AcpAgentGateway().resumeSession({
      apiVersion: API_VERSION,
      sessionRef,
    });
    try {
      await session.close();
    } catch (closeError) {
      await session.release();
      throw closeError;
    }
    writeJson(stdout, {
      apiVersion: API_VERSION,
      sessionRef,
      closed: true,
    });
    return 0;
  } catch (error) {
    writeJson(stdout, errorResponse(error));
    return 1;
  }
}

async function forget(args: string[]): Promise<number> {
  const sessionRef = parseSessionRefArg(args);
  if (typeof sessionRef !== "string") {
    writeJson(stdout, sessionRef);
    return 2;
  }

  try {
    const result = await new AcpAgentGateway().forget({
      apiVersion: API_VERSION,
      sessionRef,
    });
    writeJson(stdout, result);
    return 0;
  } catch (error) {
    writeJson(stdout, errorResponse(error));
    return 1;
  }
}

async function cleanupFailedStartSession(
  gateway: AcpAgentGateway,
  session: Awaited<ReturnType<AcpAgentGateway["createSession"]>>,
  sessionRef: string,
  agent: "opencode" | "claude" | "codex",
): Promise<void> {
  let cleanupError: unknown;
  try {
    await session.release();
  } catch (error) {
    cleanupError = error;
  }
  try {
    await gateway.forget({ apiVersion: API_VERSION, sessionRef });
  } catch (error) {
    cleanupError ??= error;
  }
  if (cleanupError) {
    writeJson(stderr, {
      apiVersion: API_VERSION,
      event: "session_update",
      timestamp: new Date().toISOString(),
      agent,
      sessionRef,
      updateType: "cleanup_failed",
      error:
        cleanupError instanceof Error
          ? cleanupError.message
          : "session cleanup failed",
    });
  }
}

function parseAgentCwdArgs(
  args: string[],
  command: string,
):
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
        `${command} accepts --agent, --cwd, and optional --input`,
      );
    }
    values.set(flag, value);
  }
  const agent = values.get("--agent");
  const cwd = values.get("--cwd");
  if (!agent || !["opencode", "claude", "codex"].includes(agent) || !cwd) {
    return cliArgumentError(
      `${command} requires --agent <name> and --cwd <absolute-path>`,
    );
  }
  return {
    ok: true,
    agent: agent as "opencode" | "claude" | "codex",
    cwd,
    ...(values.has("--input") ? { input: values.get("--input") } : {}),
  };
}

function parseSessionRefArg(args: string[]): string | Record<string, unknown> {
  if (args.length === 0) {
    return {
      apiVersion: API_VERSION,
      status: "failed",
      errorCode: "invalid_request",
      error: "Command requires --session-ref <session-ref>",
      durationMs: 0,
    };
  }
  if (args.length !== 2 || args[0] !== "--session-ref" || !args[1]) {
    return cliArgumentError("Command requires --session-ref <session-ref>")
      .error;
  }
  return args[1];
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

function errorResponse(error: unknown): Record<string, unknown> {
  if (error instanceof GatewayError) {
    return {
      apiVersion: API_VERSION,
      status: "failed",
      errorCode: error.code,
      error: error.message,
      durationMs: 0,
    };
  }
  return {
    apiVersion: API_VERSION,
    status: "failed",
    errorCode: "internal_error",
    error: error instanceof Error ? error.message : "Unknown error",
    durationMs: 0,
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function readInput(
  filePath?: string,
): Promise<string | Record<string, unknown>> {
  try {
    if (filePath) {
      return await readFile(filePath, "utf8");
    }
    return await readStdin();
  } catch (error) {
    return {
      apiVersion: API_VERSION,
      status: "failed",
      errorCode: "invalid_request",
      error: error instanceof Error ? error.message : "Failed to read input",
      durationMs: 0,
    };
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const result = Buffer.concat(chunks).toString("utf8");
  if (!result) {
    return "{}";
  }
  return result;
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
