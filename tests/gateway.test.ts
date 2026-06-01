import { fileURLToPath } from "node:url";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  AgentName,
  CreateSessionRequest,
  RunRequest,
} from "../src/contracts.js";
import { AcpAgentGateway } from "../src/gateway.js";
import { AgentRegistry, type AdapterDefinition } from "../src/registry.js";
import { SessionManager } from "../src/session.js";

const fakeAgent = fileURLToPath(
  new URL("./fixtures/fake-agent.mjs", import.meta.url),
);

describe("AcpAgentGateway", () => {
  it("returns final text and metadata-only events", async () => {
    const gateway = gatewayWithFakeAgent({ FAKE_TEXT: "final answer" });
    const result = await gateway.run(request({ includeEvents: true }));

    expect(result).toMatchObject({
      status: "completed",
      text: "final answer",
      agent: "opencode",
      cwd: process.cwd(),
      stopReason: "end_turn",
    });
    if (result.status !== "completed") {
      throw new Error("Expected completed result");
    }
    expect(result.events).toBeDefined();
    expect(JSON.stringify(result.events)).not.toContain("secret thought");
    expect(JSON.stringify(result.events)).not.toContain("final answer");
  });

  it("rejects execute permission under best-effort-read-only", async () => {
    const gateway = gatewayWithFakeAgent({ FAKE_PERMISSION_KIND: "execute" });
    const result = await gateway.run(request());

    expect(result).toMatchObject({
      status: "completed",
      text: "permission:rejectfake response",
    });
  });

  it("allows edits under best-effort-workspace-write", async () => {
    const gateway = gatewayWithFakeAgent({ FAKE_PERMISSION_KIND: "edit" });
    const result = await gateway.run(
      request({ permissionPolicy: "best-effort-workspace-write" }),
    );

    expect(result).toMatchObject({
      status: "completed",
      text: "permission:allowfake response",
    });
  });

  it("captures final text emitted shortly after prompt completion", async () => {
    const gateway = gatewayWithFakeAgent({
      FAKE_LATE_TEXT: "1",
      FAKE_TEXT: "late response",
    });
    const result = await gateway.run(request());

    expect(result).toMatchObject({
      status: "completed",
      text: "late response",
    });
  });

  it("selects an explicit model before prompting", async () => {
    const gateway = gatewayWithFakeAgent({ FAKE_ECHO_MODEL: "1" });
    const result = await gateway.run(request({ model: "test-model" }));

    expect(result).toMatchObject({
      status: "completed",
      text: "test-model",
    });
  });

  it("rejects a model not advertised by the Agent", async () => {
    const gateway = gatewayWithFakeAgent();
    const result = await gateway.run(request({ model: "missing-model" }));

    expect(result).toMatchObject({
      status: "failed",
      errorCode: "unsupported_model",
    });
  });

  it("cancels a run after its absolute timeout", async () => {
    const gateway = gatewayWithFakeAgent({ FAKE_HANG: "1" });
    const result = await gateway.run(request({ timeoutMs: 30 }));

    expect(result).toMatchObject({
      status: "failed",
      errorCode: "timeout",
    });
  });

  it("cancels a run after its idle timeout", async () => {
    const gateway = gatewayWithFakeAgent({ FAKE_HANG: "1" });
    const result = await gateway.run(
      request({ timeoutMs: 1_000, idleTimeoutMs: 30 }),
    );

    expect(result).toMatchObject({
      status: "failed",
      errorCode: "idle_timeout",
    });
  });

  it("rejects relative workspaces", async () => {
    const gateway = gatewayWithFakeAgent();
    const result = await gateway.run(request({ cwd: "." }));

    expect(result).toMatchObject({
      status: "failed",
      errorCode: "invalid_request",
    });
  });

  it("reuses one managed session while returning only the current turn text", async () => {
    const gateway = gatewayWithFakeAgent({ FAKE_ECHO_TURN: "1" });
    const session = await gateway.createSession(sessionRequest());

    try {
      const first = await session.prompt({ prompt: "first turn" });
      const second = await session.prompt({ prompt: "second turn" });

      expect(first).toMatchObject({
        status: "completed",
        text: "turn:1",
        sessionRef: session.sessionRef,
      });
      expect(second).toMatchObject({
        status: "completed",
        text: "turn:2",
        sessionRef: session.sessionRef,
      });
    } finally {
      await session.release();
    }
  });

  it("releases local resources without closing Agent-side state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    const marker = join(directory, "closed");
    const gateway = gatewayWithFakeAgent({
      FAKE_CLOSE_MARKER: marker,
      FAKE_SUPPORT_CLOSE: "1",
    });
    const session = await gateway.createSession(sessionRequest());

    try {
      await session.release();
      await expect(access(marker)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("closes Agent-side state when session/close is advertised", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    const marker = join(directory, "closed");
    const gateway = gatewayWithFakeAgent({
      FAKE_CLOSE_MARKER: marker,
      FAKE_SUPPORT_CLOSE: "1",
    });
    const session = await gateway.createSession(sessionRequest());

    try {
      await session.close();
      await expect(readFile(marker, "utf8")).resolves.toBe("closed\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects unsupported close without silently degrading its meaning", async () => {
    const gateway = gatewayWithFakeAgent();
    const session = await gateway.createSession(sessionRequest());

    await expect(session.close()).rejects.toMatchObject({
      code: "unsupported_session_close",
    });
    await expect(
      session.prompt({ prompt: "after close" }),
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "invalid_session_state",
    });
  });

  it("rejects prompts after release", async () => {
    const gateway = gatewayWithFakeAgent();
    const session = await gateway.createSession(sessionRequest());

    await session.release();

    await expect(
      session.prompt({ prompt: "after release" }),
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "invalid_session_state",
    });
  });

  it("reuses a managed session after a prompt timeout cancels cleanly", async () => {
    const gateway = gatewayWithFakeAgent({
      FAKE_ECHO_TURN: "1",
      FAKE_HANG_FIRST: "1",
    });
    const session = await gateway.createSession(sessionRequest());

    try {
      await expect(
        session.prompt({ prompt: "hang", timeoutMs: 30 }),
      ).resolves.toMatchObject({
        status: "failed",
        errorCode: "timeout",
      });
      await expect(
        session.prompt({ prompt: "continue", timeoutMs: 1_000 }),
      ).resolves.toMatchObject({
        status: "completed",
        text: "turn:2",
      });
    } finally {
      await session.release();
    }
  });

  it("rejects concurrent prompts within one managed session", async () => {
    const gateway = gatewayWithFakeAgent({ FAKE_HANG_FIRST: "1" });
    const session = await gateway.createSession(sessionRequest());

    try {
      const first = session.prompt({ prompt: "hang", timeoutMs: 30 });
      await expect(
        session.prompt({ prompt: "overlap", timeoutMs: 1_000 }),
      ).resolves.toMatchObject({
        status: "failed",
        errorCode: "invalid_session_state",
      });
      await expect(first).resolves.toMatchObject({
        status: "failed",
        errorCode: "timeout",
      });
    } finally {
      await session.release();
    }
  });

  it("rejects session creation after its timeout", async () => {
    const gateway = gatewayWithFakeAgent({ FAKE_HANG_INITIALIZE: "1" });

    await expect(
      gateway.createSession(sessionRequest({ timeoutMs: 30 })),
    ).rejects.toMatchObject({
      code: "timeout",
    });
  });
});

function gatewayWithFakeAgent(env: NodeJS.ProcessEnv = {}): AcpAgentGateway {
  const definitions = Object.fromEntries(
    (["opencode", "claude", "codex"] as const).map((agent) => [
      agent,
      definition(agent, env),
    ]),
  ) as Record<AgentName, AdapterDefinition>;
  return new AcpAgentGateway(
    new SessionManager(new AgentRegistry(definitions)),
  );
}

function definition(
  agent: AgentName,
  env: NodeJS.ProcessEnv,
): AdapterDefinition {
  if (agent === "opencode") {
    return {
      agent,
      support: "verified",
      command: "node",
      args: [fakeAgent],
      installHint: "test",
      env,
    };
  }
  return {
    agent,
    support: "reserved",
    command: agent,
    args: [],
    installHint: "test",
  };
}

function request(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    apiVersion: "v1",
    agent: "opencode",
    cwd: process.cwd(),
    prompt: "inspect repository",
    permissionPolicy: "best-effort-read-only",
    timeoutMs: 1_000,
    gracePeriodMs: 50,
    includeEvents: false,
    ...overrides,
  };
}

function sessionRequest(
  overrides: Partial<CreateSessionRequest> = {},
): CreateSessionRequest {
  return {
    apiVersion: "v1",
    agent: "opencode",
    cwd: process.cwd(),
    permissionPolicy: "best-effort-read-only",
    timeoutMs: 1_000,
    ...overrides,
  };
}
