import { execFile } from "node:child_process";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { API_VERSION, RunEventSchema } from "../src/contracts.js";

const CLI_TIMEOUT = 30_000;
const FAKE_ADAPTER_COMMAND = `node ${fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url))}`;

function agentEnv(
  stateDir: string,
  env: Record<string, string> = {},
): Record<string, string> {
  return {
    ...process.env,
    ACP_AGENT_GATEWAY_STATE_DIR: stateDir,
    ACP_AGENT_GATEWAY_FAKE_ADAPTER: FAKE_ADAPTER_COMMAND,
    ...env,
  };
}

function runCli(
  args: string[],
  opts?: {
    input?: string;
    env?: Record<string, string>;
    entryPoint?: string;
  },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const entry = opts?.entryPoint ?? "src/cli.ts";
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      ["--import", "tsx", entry, ...args],
      {
        cwd: process.cwd(),
        env: opts?.env ?? process.env,
      },
      (error, stdout, stderr) => {
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          exitCode: error ? 1 : 0,
        });
      },
    );
    if (opts?.input !== undefined) {
      child.stdin?.write(opts.input);
    }
    child.stdin?.end();
  });
}

function parseJsonLines(text: string): unknown[] {
  return text
    .trim()
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

async function startDurableSession(
  stateDir: string,
  sessionId: string,
  env: Record<string, string> = {},
): Promise<string> {
  const { stdout } = await runCli(
    ["start-session", "--agent", "opencode", "--cwd", process.cwd()],
    {
      input: JSON.stringify({
        apiVersion: "v1",
        permissionPolicy: "best-effort-read-only",
        prompt: "establish recoverable context",
        timeoutMs: 5000,
      }),
      env: agentEnv(stateDir, {
        FAKE_SESSION_ID: sessionId,
        ...env,
      }),
    },
  );
  const result = JSON.parse(stdout);
  expect(result.status).toBe("completed");
  return result.sessionRef;
}

describe("Gateway CLI", () => {
  it("reports adapter availability through doctor", async () => {
    const { stdout } = await runCli(["doctor"]);
    const result = JSON.parse(stdout);

    expect(result).toMatchObject({
      apiVersion: "v1",
      status: "completed",
    });
    expect(result.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agent: "opencode",
          support: "verified",
          available: true,
        }),
      ]),
    );
  });

  it("rejects prompt text passed through command-line arguments", async () => {
    const { stdout } = await runCli([
      "run",
      "--agent",
      "opencode",
      "--cwd",
      process.cwd(),
      "--prompt",
      "secret",
    ]);
    const result = JSON.parse(stdout);

    expect(result).toMatchObject({
      apiVersion: "v1",
      status: "failed",
      errorCode: "invalid_request",
    });
  });
});

describe("Phase 3D JSON CLI durable session lifecycle", () => {
  it(
    "start-session creates durable session, prompts first turn, and releases",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
      try {
        const env = agentEnv(dir, {
          FAKE_ADVERTISE_RESUME: "1",
          FAKE_SUPPORT_CLOSE: "1",
          FAKE_SESSION_ID: "cli-start",
        });
        const input = JSON.stringify({
          apiVersion: "v1",
          permissionPolicy: "best-effort-read-only",
          prompt: "start session first turn",
          timeoutMs: 5000,
        });

        const { stdout, stderr } = await runCli(
          ["start-session", "--agent", "opencode", "--cwd", process.cwd()],
          { input, env },
        );

        const result = JSON.parse(stdout);
        expect(result.apiVersion).toBe(API_VERSION);
        expect(result.sessionRef).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
        expect(result.status).toBe("completed");

        const events = parseJsonLines(stderr);
        for (const event of events) {
          expect(event).toHaveProperty("apiVersion");
          expect(JSON.stringify(event)).not.toContain("secret thought");
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    CLI_TIMEOUT,
  );

  it(
    "resumes a session via resume-session",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
      try {
        const sessionRef = await startDurableSession(dir, "cli-resume", {
          FAKE_ADVERTISE_RESUME: "1",
          FAKE_SUPPORT_CLOSE: "1",
        });

        const resumeEnv = agentEnv(dir, {
          FAKE_ADVERTISE_RESUME: "1",
          FAKE_SUPPORT_CLOSE: "1",
          FAKE_KNOWN_SESSIONS: "cli-resume",
          FAKE_TEXT: "recovered-via-cli",
        });
        const { stdout: resumeStdout } = await runCli(
          ["resume-session", "--session-ref", sessionRef],
          { env: resumeEnv },
        );

        const resumeResult = JSON.parse(resumeStdout);
        expect(resumeResult.apiVersion).toBe(API_VERSION);
        expect(resumeResult.sessionRef).toBe(sessionRef);
        expect(resumeResult.recovery).toBe("resumed");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    CLI_TIMEOUT,
  );

  it(
    "rejects cross-process recovery while a live lease is held",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
      try {
        const sessionRef = await startDurableSession(dir, "cli-live-lease", {
          FAKE_ADVERTISE_RESUME: "1",
        });
        await writeFile(
          join(dir, "sessions", `${sessionRef}.lease.json`),
          JSON.stringify({
            schemaVersion: 1,
            sessionRef,
            leaseId: "00000000-0000-4000-a000-000000000099",
            pid: process.pid,
            createdAt: new Date().toISOString(),
          }),
          { mode: 0o600 },
        );

        const { stdout } = await runCli(
          ["resume-session", "--session-ref", sessionRef],
          {
            env: agentEnv(dir, {
              FAKE_ADVERTISE_RESUME: "1",
              FAKE_KNOWN_SESSIONS: "cli-live-lease",
            }),
          },
        );

        expect(JSON.parse(stdout)).toMatchObject({
          apiVersion: API_VERSION,
          status: "failed",
          errorCode: "invalid_session_state",
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    CLI_TIMEOUT,
  );

  it(
    "returns one failure JSON when resume-session lease cleanup fails",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
      try {
        const sessionRef = await startDurableSession(
          dir,
          "cli-release-failure",
          {
            FAKE_ADVERTISE_RESUME: "1",
          },
        );
        const { stdout } = await runCli(
          ["resume-session", "--session-ref", sessionRef],
          {
            env: agentEnv(dir, {
              ACP_AGENT_GATEWAY_TEST_RELEASE_LEASE_FAILURE: "1",
              FAKE_ADVERTISE_RESUME: "1",
              FAKE_KNOWN_SESSIONS: "cli-release-failure",
            }),
            entryPoint: "tests/fixtures/cli-test-entry.ts",
          },
        );

        const output = parseJsonLines(stdout);
        expect(output).toHaveLength(1);
        expect(output[0]).toMatchObject({
          apiVersion: API_VERSION,
          status: "failed",
          errorCode: "session_cleanup_failed",
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    CLI_TIMEOUT,
  );

  it(
    "retains a successful start-session record when lease cleanup fails",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
      try {
        const { stdout } = await runCli(
          ["start-session", "--agent", "opencode", "--cwd", process.cwd()],
          {
            input: JSON.stringify({
              apiVersion: "v1",
              permissionPolicy: "best-effort-read-only",
              prompt: "establish recoverable context",
              timeoutMs: 5000,
            }),
            env: agentEnv(dir, {
              ACP_AGENT_GATEWAY_TEST_RELEASE_LEASE_FAILURE: "1",
              FAKE_SESSION_ID: "cli-start-release-failure",
            }),
            entryPoint: "tests/fixtures/cli-test-entry.ts",
          },
        );

        const output = parseJsonLines(stdout);
        expect(output).toHaveLength(1);
        expect(output[0]).toMatchObject({
          apiVersion: API_VERSION,
          status: "failed",
          errorCode: "session_cleanup_failed",
        });
        const sessionRef = (output[0] as { sessionRef: string }).sessionRef;
        await expect(
          readFile(join(dir, "sessions", `${sessionRef}.json`), "utf8"),
        ).resolves.toBeDefined();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    CLI_TIMEOUT,
  );

  it(
    "prompts through a resumed session",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
      try {
        const sessionRef = await startDurableSession(dir, "cli-prompt", {
          FAKE_ADVERTISE_RESUME: "1",
          FAKE_SUPPORT_CLOSE: "1",
        });

        const promptEnv = agentEnv(dir, {
          FAKE_ADVERTISE_RESUME: "1",
          FAKE_SESSION_ID: "cli-prompt",
          FAKE_KNOWN_SESSIONS: "cli-prompt",
          FAKE_TEXT: "hello-from-prompt",
        });
        const promptInput = JSON.stringify({
          prompt: "test prompt",
          timeoutMs: 5000,
        });

        const { stdout: promptStdout, stderr: promptStderr } = await runCli(
          ["prompt", "--session-ref", sessionRef],
          { input: promptInput, env: promptEnv },
        );

        const promptResult = JSON.parse(promptStdout);
        expect(promptResult.status).toBe("completed");
        expect(promptResult.text).toBe("hello-from-prompt");

        const events = parseJsonLines(promptStderr);
        for (const event of events) {
          expect(JSON.stringify(event)).not.toContain("hello-from-prompt");
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    CLI_TIMEOUT,
  );

  it("rejects invalid prompt input before attempting recovery", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    try {
      const { stdout } = await runCli(
        ["prompt", "--session-ref", "00000000-0000-4000-a000-000000000099"],
        { input: "{}", env: agentEnv(dir) },
      );

      const result = JSON.parse(stdout);
      expect(result).toMatchObject({
        apiVersion: "v1",
        status: "failed",
        errorCode: "invalid_request",
      });
      expect(result.error).toContain("prompt");
      expect(result.error).not.toContain("Session reference not found");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it(
    "closes a session and removes its state",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
      try {
        const sessionRef = await startDurableSession(dir, "cli-close", {
          FAKE_ADVERTISE_RESUME: "1",
          FAKE_SUPPORT_CLOSE: "1",
        });

        const closeEnv = agentEnv(dir, {
          FAKE_ADVERTISE_RESUME: "1",
          FAKE_SUPPORT_CLOSE: "1",
          FAKE_KNOWN_SESSIONS: "cli-close",
        });
        const { stdout: closeStdout } = await runCli(
          ["close", "--session-ref", sessionRef],
          { env: closeEnv },
        );

        const closeResult = JSON.parse(closeStdout);
        expect(closeResult).toMatchObject({
          apiVersion: API_VERSION,
          sessionRef,
          closed: true,
        });

        await expect(
          readFile(join(dir, "sessions", `${sessionRef}.json`), "utf8"),
        ).rejects.toThrow();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    CLI_TIMEOUT,
  );

  it(
    "reports close cleanup failure and leaves the reference for forget",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
      try {
        const sessionRef = await startDurableSession(
          dir,
          "cli-close-cleanup-failure",
          {
            FAKE_ADVERTISE_RESUME: "1",
            FAKE_SUPPORT_CLOSE: "1",
          },
        );

        const closeEnv = agentEnv(dir, {
          ACP_AGENT_GATEWAY_TEST_REMOVE_FAILURE: "1",
          FAKE_ADVERTISE_RESUME: "1",
          FAKE_SUPPORT_CLOSE: "1",
          FAKE_KNOWN_SESSIONS: "cli-close-cleanup-failure",
        });
        const { stdout: closeStdout } = await runCli(
          ["close", "--session-ref", sessionRef],
          { env: closeEnv, entryPoint: "tests/fixtures/cli-test-entry.ts" },
        );

        const closeResult = JSON.parse(closeStdout);
        expect(closeResult).toMatchObject({
          apiVersion: API_VERSION,
          status: "failed",
          errorCode: "session_cleanup_failed",
        });
        await expect(
          readFile(join(dir, "sessions", `${sessionRef}.json`), "utf8"),
        ).resolves.toBeDefined();

        const { stdout: forgetStdout } = await runCli(
          ["forget", "--session-ref", sessionRef],
          { env: agentEnv(dir) },
        );
        expect(JSON.parse(forgetStdout)).toMatchObject({
          apiVersion: API_VERSION,
          sessionRef,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    CLI_TIMEOUT,
  );

  it(
    "forgets a durable session reference",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
      try {
        const sessionRef = await startDurableSession(dir, "cli-forget", {
          FAKE_ADVERTISE_RESUME: "1",
        });

        const { stdout: forgetStdout } = await runCli(
          ["forget", "--session-ref", sessionRef],
          {
            env: agentEnv(dir),
          },
        );

        const forgetResult = JSON.parse(forgetStdout);
        expect(forgetResult).toMatchObject({
          apiVersion: API_VERSION,
          sessionRef,
        });

        await expect(
          readFile(join(dir, "sessions", `${sessionRef}.json`), "utf8"),
        ).rejects.toThrow();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    CLI_TIMEOUT,
  );

  it("forgets a non-existent durable session reference idempotently", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    const sessionRef = "00000000-0000-4000-a000-000000000099";
    try {
      const { stdout } = await runCli(["forget", "--session-ref", sessionRef], {
        env: agentEnv(dir),
      });

      expect(JSON.parse(stdout)).toEqual({
        apiVersion: API_VERSION,
        sessionRef,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects resume-session command-line overrides", async () => {
    const { stdout } = await runCli([
      "resume-session",
      "--session-ref",
      "00000000-0000-4000-a000-000000000001",
      "--fallback",
      "new-session",
    ]);

    const result = JSON.parse(stdout);
    expect(result).toMatchObject({
      apiVersion: "v1",
      status: "failed",
      errorCode: "invalid_request",
    });
  });

  it(
    "completes a full cross-process lifecycle via start-session, prompt, and close",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
      try {
        const startEnv = agentEnv(dir, {
          FAKE_ADVERTISE_RESUME: "1",
          FAKE_SUPPORT_CLOSE: "1",
          FAKE_SESSION_ID: "cli-lifecycle",
          FAKE_TEXT: "first-turn-text",
        });
        const startInput = JSON.stringify({
          apiVersion: "v1",
          permissionPolicy: "best-effort-read-only",
          prompt: "first turn",
          timeoutMs: 5000,
        });

        const { stdout: startStdout } = await runCli(
          ["start-session", "--agent", "opencode", "--cwd", process.cwd()],
          { input: startInput, env: startEnv },
        );
        const startResult = JSON.parse(startStdout);
        expect(startResult.status).toBe("completed");
        expect(startResult.text).toBe("first-turn-text");
        const sessionRef = startResult.sessionRef;

        const promptEnv = agentEnv(dir, {
          FAKE_ADVERTISE_RESUME: "1",
          FAKE_SESSION_ID: "cli-lifecycle",
          FAKE_KNOWN_SESSIONS: "cli-lifecycle",
          FAKE_TEXT: "second-turn-text",
        });
        const promptInput = JSON.stringify({
          prompt: "second turn",
          timeoutMs: 5000,
        });
        const { stdout: promptStdout } = await runCli(
          ["prompt", "--session-ref", sessionRef],
          { input: promptInput, env: promptEnv },
        );
        const promptResult = JSON.parse(promptStdout);
        expect(promptResult.status).toBe("completed");
        expect(promptResult.text).toBe("second-turn-text");

        const closeEnv = agentEnv(dir, {
          FAKE_ADVERTISE_RESUME: "1",
          FAKE_SUPPORT_CLOSE: "1",
          FAKE_KNOWN_SESSIONS: "cli-lifecycle",
        });
        const { stdout: closeStdout } = await runCli(
          ["close", "--session-ref", sessionRef],
          { env: closeEnv },
        );
        const closeResult = JSON.parse(closeStdout);
        expect(closeResult).toMatchObject({
          apiVersion: API_VERSION,
          sessionRef,
          closed: true,
        });

        await expect(
          readFile(join(dir, "sessions", `${sessionRef}.json`), "utf8"),
        ).rejects.toThrow();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    CLI_TIMEOUT,
  );

  it(
    "removes the durable record when start-session first prompt fails",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
      try {
        const env = agentEnv(dir, {
          FAKE_SESSION_ID: "cli-cleanup",
          FAKE_STOP_REASON: "future_reason",
        });
        const input = JSON.stringify({
          apiVersion: "v1",
          permissionPolicy: "best-effort-read-only",
          prompt: "will fail",
          timeoutMs: 5000,
        });

        const { stdout } = await runCli(
          ["start-session", "--agent", "opencode", "--cwd", process.cwd()],
          { input, env },
        );
        const result = JSON.parse(stdout);
        expect(result.status).toBe("failed");
        expect(result.sessionRef).toBeDefined();

        const ref = result.sessionRef;
        await expect(
          readFile(join(dir, "sessions", `${ref}.json`), "utf8"),
        ).rejects.toThrow();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    CLI_TIMEOUT,
  );

  it(
    "reports forget cleanup failure on stderr without silently dropping it",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
      try {
        const env = agentEnv(dir, {
          ACP_AGENT_GATEWAY_TEST_REMOVE_FAILURE: "1",
          FAKE_SESSION_ID: "cli-cleanup-err",
          FAKE_STOP_REASON: "future_reason",
        });
        const input = JSON.stringify({
          apiVersion: "v1",
          permissionPolicy: "best-effort-read-only",
          prompt: "will fail",
          timeoutMs: 5000,
        });

        const { stdout, stderr } = await runCli(
          ["start-session", "--agent", "opencode", "--cwd", process.cwd()],
          { input, env, entryPoint: "tests/fixtures/cli-test-entry.ts" },
        );
        const result = JSON.parse(stdout);
        expect(result.status).toBe("failed");
        expect(result.sessionRef).toBeDefined();

        const cleanupEvents = parseJsonLines(stderr)
          .map((e) => RunEventSchema.safeParse(e))
          .filter((r) => r.success && r.data.updateType === "cleanup_failed");
        expect(cleanupEvents.length).toBe(1);
        const event = cleanupEvents[0].data;
        expect(event.event).toBe("session_update");
        expect(event.agent).toBe("opencode");
        expect(event.timestamp).toBeDefined();
        expect(event.error).toBeDefined();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    CLI_TIMEOUT,
  );
});
