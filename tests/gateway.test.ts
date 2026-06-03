import { fileURLToPath } from "node:url";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { SessionStateStore, type SessionRecord } from "../src/store.js";

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

  it("reports empty_response stopReason when agent completes without message text", async () => {
    const gateway = gatewayWithFakeAgent({ FAKE_EMPTY_TEXT: "1" });
    const result = await gateway.run(request());

    expect(result).toMatchObject({
      status: "completed",
      text: "",
      stopReason: "empty_response",
    });
  });

  it.each(["max_tokens", "max_turn_requests", "refusal"] as const)(
    "preserves ACP stop reason %s",
    async (stopReason) => {
      const gateway = gatewayWithFakeAgent({ FAKE_STOP_REASON: stopReason });
      const result = await gateway.run(request());

      expect(result).toMatchObject({
        status: "completed",
        stopReason,
      });
    },
  );

  it("preserves an ACP stop reason when the response text is empty", async () => {
    const gateway = gatewayWithFakeAgent({
      FAKE_EMPTY_TEXT: "1",
      FAKE_STOP_REASON: "max_tokens",
    });
    const result = await gateway.run(request());

    expect(result).toMatchObject({
      status: "completed",
      text: "",
      stopReason: "max_tokens",
    });
  });

  it("rejects Agent stop reasons outside the public contract", async () => {
    const gateway = gatewayWithFakeAgent({ FAKE_STOP_REASON: "future_reason" });
    const result = await gateway.run(request());

    expect(result).toMatchObject({
      status: "failed",
      errorCode: "protocol_error",
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

describe("Phase 3 durable sessions and recovery", () => {
  it("persists a durable session record on create", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    const store = new SessionStateStore(dir);
    try {
      const gateway = gatewayWithStore(dir, {
        FAKE_ADVERTISE_RESUME: "1",
        FAKE_SUPPORT_CLOSE: "1",
        FAKE_SESSION_ID: "recovery-test",
      });
      const session = await gateway.createSession(
        sessionRequest({ durable: true, model: "test-model" }),
      );
      const record = await store.load(session.sessionRef);
      expect(record).toBeDefined();
      if (record) {
        expect(record.agent).toBe("opencode");
        expect(record.acpSessionId).toBe("recovery-test");
        expect(record.model).toBe("test-model");
        expect(record.capabilitySnapshot.resumeSession).toBe(true);
      }
      await session.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("deletes a durable record on close", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    const store = new SessionStateStore(dir);
    try {
      const gateway = gatewayWithStore(dir, {
        FAKE_ADVERTISE_RESUME: "1",
        FAKE_SUPPORT_CLOSE: "1",
        FAKE_SUPPORT_CLOSE: "1",
        FAKE_SESSION_ID: "close-test",
      });
      const session = await gateway.createSession(
        sessionRequest({ durable: true }),
      );
      await session.close();
      const record = await store.load(session.sessionRef);
      expect(record).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports durable record cleanup failure after Agent-side close", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    const store = new FailOnceRemoveStore(dir);
    try {
      const gateway = gatewayWithStore(
        dir,
        {
          FAKE_SUPPORT_CLOSE: "1",
          FAKE_SESSION_ID: "close-cleanup-failure-test",
        },
        store,
      );
      const session = await gateway.createSession(
        sessionRequest({ durable: true }),
      );

      await expect(session.close()).rejects.toMatchObject({
        code: "session_cleanup_failed",
      });
      await expect(store.load(session.sessionRef)).resolves.toMatchObject({
        lifecycle: "closing",
      });
      await expect(
        gateway.resumeSession({
          apiVersion: "v1",
          sessionRef: session.sessionRef,
        }),
      ).rejects.toMatchObject({
        code: "invalid_session_state",
      });

      await gateway.forget({
        apiVersion: "v1",
        sessionRef: session.sessionRef,
      });
      await expect(store.load(session.sessionRef)).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("leaves a durable record closing when Agent-side close fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    const store = new SessionStateStore(dir);
    try {
      const gateway = gatewayWithStore(
        dir,
        {
          FAKE_ADVERTISE_RESUME: "1",
          FAKE_SUPPORT_CLOSE: "1",
          FAKE_CLOSE_ERROR: "1",
          FAKE_SESSION_ID: "agent-close-failure-test",
        },
        store,
      );
      const session = await gateway.createSession(
        sessionRequest({ durable: true }),
      );

      await expect(session.close()).rejects.toThrow();
      await expect(store.load(session.sessionRef)).resolves.toMatchObject({
        lifecycle: "closing",
      });
      await expect(
        gateway.resumeSession({
          apiVersion: "v1",
          sessionRef: session.sessionRef,
        }),
      ).rejects.toMatchObject({
        code: "invalid_session_state",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("releases local resources when marking a durable record closing fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    const store = new FailSecondSaveStore(dir);
    try {
      const gateway = gatewayWithStore(
        dir,
        {
          FAKE_ADVERTISE_RESUME: "1",
          FAKE_SUPPORT_CLOSE: "1",
          FAKE_SESSION_ID: "close-marking-failure-test",
        },
        store,
      );
      const session = await gateway.createSession(
        sessionRequest({ durable: true }),
      );

      await expect(session.close()).rejects.toMatchObject({
        code: "session_cleanup_failed",
      });
      await expect(store.load(session.sessionRef)).resolves.toMatchObject({
        lifecycle: "active",
      });
      await expect(
        session.prompt({ prompt: "must not use released adapter" }),
      ).resolves.toMatchObject({
        status: "failed",
        errorCode: "invalid_session_state",
      });

      const resumeGateway = gatewayWithStore(
        dir,
        {
          FAKE_ADVERTISE_RESUME: "1",
          FAKE_KNOWN_SESSIONS: "close-marking-failure-test",
        },
        store,
      );
      const result = await resumeGateway.resumeSession({
        apiVersion: "v1",
        sessionRef: session.sessionRef,
      });
      expect(result.recovery).toBe("resumed");
      await result.session.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps a durable record active when close is unsupported", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    const store = new SessionStateStore(dir);
    try {
      const gateway = gatewayWithStore(dir, {
        FAKE_ADVERTISE_RESUME: "1",
        FAKE_SESSION_ID: "unsupported-close-test",
      });
      const session = await gateway.createSession(
        sessionRequest({ durable: true }),
      );

      await expect(session.close()).rejects.toMatchObject({
        code: "unsupported_session_close",
      });
      await expect(store.load(session.sessionRef)).resolves.toMatchObject({
        lifecycle: "active",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a closing record before resolving an adapter", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    const store = new SessionStateStore(dir);
    try {
      const gateway = gatewayWithStore(dir, {
        FAKE_SUPPORT_CLOSE: "1",
        FAKE_CLOSE_ERROR: "1",
        FAKE_SESSION_ID: "closing-before-resolve-test",
      });
      const session = await gateway.createSession(
        sessionRequest({ durable: true }),
      );
      await expect(session.close()).rejects.toThrow();

      const registry = registryWithMissingOpenCode();
      const resumeGateway = new AcpAgentGateway(
        new SessionManager(registry),
        store,
        registry,
      );
      await expect(
        resumeGateway.resumeSession({
          apiVersion: "v1",
          sessionRef: session.sessionRef,
        }),
      ).rejects.toMatchObject({
        code: "invalid_session_state",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("retains a durable record on release", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    const store = new SessionStateStore(dir);
    try {
      const gateway = gatewayWithStore(dir, {
        FAKE_ADVERTISE_RESUME: "1",
        FAKE_SESSION_ID: "release-test",
      });
      const session = await gateway.createSession(
        sessionRequest({ durable: true }),
      );
      await session.release();
      const record = await store.load(session.sessionRef);
      expect(record).toBeDefined();
      expect(record?.acpSessionId).toBe("release-test");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("releases a durable session lease once across concurrent release calls", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    const store = new CountReleaseLeaseStore(dir);
    try {
      const gateway = gatewayWithStore(
        dir,
        {
          FAKE_ADVERTISE_RESUME: "1",
          FAKE_SESSION_ID: "concurrent-release-test",
        },
        store,
      );
      const session = await gateway.createSession(
        sessionRequest({ durable: true }),
      );

      await Promise.all([session.release(), session.release()]);
      expect(store.releaseLeaseCount).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects concurrent recovery while a durable session lease is held", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    try {
      const createGateway = gatewayWithStore(dir, {
        FAKE_ADVERTISE_RESUME: "1",
        FAKE_SESSION_ID: "leased-recovery-test",
      });
      const created = await createGateway.createSession(
        sessionRequest({ durable: true }),
      );

      const resumeGateway = gatewayWithStore(dir, {
        FAKE_ADVERTISE_RESUME: "1",
        FAKE_KNOWN_SESSIONS: "leased-recovery-test",
      });
      await expect(
        resumeGateway.resumeSession({
          apiVersion: "v1",
          sessionRef: created.sessionRef,
        }),
      ).rejects.toMatchObject({
        code: "invalid_session_state",
      });

      await created.release();
      const result = await resumeGateway.resumeSession({
        apiVersion: "v1",
        sessionRef: created.sessionRef,
      });
      expect(result.recovery).toBe("resumed");
      await result.session.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resumes a durable session via session/resume", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    try {
      const createGateway = gatewayWithStore(dir, {
        FAKE_ADVERTISE_RESUME: "1",
        FAKE_SUPPORT_CLOSE: "1",
        FAKE_SESSION_ID: "resume-test",
      });
      const created = await createGateway.createSession(
        sessionRequest({ durable: true }),
      );
      const originalRef = created.sessionRef;
      await created.release();

      const resumeGateway = gatewayWithStore(dir, {
        FAKE_ADVERTISE_RESUME: "1",
        FAKE_SUPPORT_CLOSE: "1",
        FAKE_KNOWN_SESSIONS: "resume-test",
        FAKE_TEXT: "recovered",
      });
      const result = await resumeGateway.resumeSession({
        apiVersion: "v1",
        sessionRef: originalRef,
      });
      expect(result.recovery).toBe("resumed");
      expect(result.session.sessionRef).toBe(originalRef);

      const promptResult = await result.session.prompt({
        prompt: "test",
        timeoutMs: 2_000,
      });
      expect(promptResult).toMatchObject({
        status: "completed",
        text: "recovered",
      });
      await result.session.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to session/load when resume is unavailable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    try {
      const createGateway = gatewayWithStore(dir, {
        FAKE_ADVERTISE_LOAD: "1",
        FAKE_SUPPORT_CLOSE: "1",
        FAKE_SESSION_ID: "load-test",
      });
      const created = await createGateway.createSession(
        sessionRequest({ durable: true }),
      );
      const originalRef = created.sessionRef;
      await created.release();

      const resumeGateway = gatewayWithStore(dir, {
        FAKE_ADVERTISE_LOAD: "1",
        FAKE_SUPPORT_CLOSE: "1",
        FAKE_KNOWN_SESSIONS: "load-test",
        FAKE_TEXT: "load-recovered",
      });
      const result = await resumeGateway.resumeSession({
        apiVersion: "v1",
        sessionRef: originalRef,
      });
      expect(result.recovery).toBe("resumed");
      await result.session.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("prefers session/resume when both resume and load are available", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    try {
      const createGateway = gatewayWithStore(dir, {
        FAKE_ADVERTISE_LOAD: "1",
        FAKE_ADVERTISE_RESUME: "1",
        FAKE_SESSION_ID: "resume-preference-test",
      });
      const created = await createGateway.createSession(
        sessionRequest({ durable: true }),
      );
      const originalRef = created.sessionRef;
      await created.release();

      const resumeGateway = gatewayWithStore(dir, {
        FAKE_ADVERTISE_LOAD: "1",
        FAKE_ADVERTISE_RESUME: "1",
        FAKE_KNOWN_SESSIONS: "resume-preference-test",
        FAKE_SUPPRESS_LOAD: "1",
      });
      const result = await resumeGateway.resumeSession({
        apiVersion: "v1",
        sessionRef: originalRef,
      });
      expect(result.recovery).toBe("resumed");
      await result.session.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not use a recovery capability absent from the persisted snapshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    try {
      const createGateway = gatewayWithStore(dir, {
        FAKE_ADVERTISE_LOAD: "1",
        FAKE_SESSION_ID: "capability-intersection-test",
      });
      const created = await createGateway.createSession(
        sessionRequest({ durable: true }),
      );
      const originalRef = created.sessionRef;
      await created.release();

      const resumeGateway = gatewayWithStore(dir, {
        FAKE_ADVERTISE_LOAD: "1",
        FAKE_ADVERTISE_RESUME: "1",
        FAKE_KNOWN_SESSIONS: "capability-intersection-test",
        FAKE_SUPPRESS_RESUME: "1",
      });
      const result = await resumeGateway.resumeSession({
        apiVersion: "v1",
        sessionRef: originalRef,
      });
      expect(result.recovery).toBe("resumed");
      await result.session.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("suppresses historical replay during session/load", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    try {
      const createGateway = gatewayWithStore(dir, {
        FAKE_ADVERTISE_LOAD: "1",
        FAKE_SUPPORT_CLOSE: "1",
        FAKE_SESSION_ID: "replay-test",
      });
      const created = await createGateway.createSession(
        sessionRequest({ durable: true }),
      );
      const originalRef = created.sessionRef;
      await created.release();

      const resumeGateway = gatewayWithStore(dir, {
        FAKE_ADVERTISE_LOAD: "1",
        FAKE_SUPPORT_CLOSE: "1",
        FAKE_KNOWN_SESSIONS: "replay-test",
        FAKE_REPLAY_CHUNKS: "3",
        FAKE_TEXT: "real-text",
      });
      const result = await resumeGateway.resumeSession({
        apiVersion: "v1",
        sessionRef: originalRef,
      });
      expect(result.recovery).toBe("resumed");

      const promptResult = await result.session.prompt({
        prompt: "test",
        timeoutMs: 2_000,
      });
      expect(promptResult.status).toBe("completed");
      if (promptResult.status === "completed") {
        expect(promptResult.text).not.toContain("replay:1");
        expect(promptResult.text).not.toContain("replay:2");
        expect(promptResult.text).not.toContain("replay:3");
      }
      await result.session.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns error for non-existent session reference", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    try {
      const gateway = gatewayWithStore(dir);
      await expect(
        gateway.resumeSession({
          apiVersion: "v1",
          sessionRef: "00000000-0000-4000-a000-000000000099",
        }),
      ).rejects.toMatchObject({
        code: "invalid_request",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a corrupted record and allows explicit forget cleanup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    const store = new SessionStateStore(dir);
    try {
      const gateway = gatewayWithStore(
        dir,
        {
          FAKE_ADVERTISE_RESUME: "1",
          FAKE_SESSION_ID: "corrupted-record-test",
        },
        store,
      );
      const created = await gateway.createSession(
        sessionRequest({ durable: true }),
      );
      const sessionRef = created.sessionRef;
      await created.release();
      await writeFile(join(dir, "sessions", `${sessionRef}.json`), "not-json", {
        mode: 0o600,
      });

      await expect(
        gateway.resumeSession({
          apiVersion: "v1",
          sessionRef,
        }),
      ).rejects.toMatchObject({
        code: "invalid_session_state",
      });

      await gateway.forget({ apiVersion: "v1", sessionRef });
      await expect(store.load(sessionRef)).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects session with incompatible adapter fingerprint", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    try {
      const createGateway = gatewayWithStore(dir, {
        FAKE_ADVERTISE_RESUME: "1",
        FAKE_SESSION_ID: "incompat-test",
      });
      const created = await createGateway.createSession(
        sessionRequest({ durable: true }),
      );
      const originalRef = created.sessionRef;
      await created.release();

      const resumeGateway = gatewayWithStoreAltered(dir, {
        FAKE_ADVERTISE_RESUME: "1",
        FAKE_SESSION_ID: "incompat-test",
      });
      await expect(
        resumeGateway.resumeSession({
          apiVersion: "v1",
          sessionRef: originalRef,
        }),
      ).rejects.toMatchObject({
        code: "incompatible_session",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns unsupported_session_recovery when neither resume nor load is available", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    try {
      const createGateway = gatewayWithStore(dir, {
        FAKE_SUPPORT_CLOSE: "1",
        FAKE_SESSION_ID: "no-recovery-test",
      });
      const created = await createGateway.createSession(
        sessionRequest({ durable: true }),
      );
      const originalRef = created.sessionRef;
      await created.release();

      const resumeGateway = gatewayWithStore(dir, {
        FAKE_SUPPORT_CLOSE: "1",
        FAKE_SESSION_ID: "no-recovery-test",
      });
      await expect(
        resumeGateway.resumeSession({
          apiVersion: "v1",
          sessionRef: originalRef,
        }),
      ).rejects.toMatchObject({
        code: "unsupported_session_recovery",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("recovers via fallback new-session when requested recovery fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    try {
      const createGateway = gatewayWithStore(dir, {
        FAKE_SUPPORT_CLOSE: "1",
        FAKE_SESSION_ID: "fallback-test",
      });
      const created = await createGateway.createSession(
        sessionRequest({ durable: true }),
      );
      const originalRef = created.sessionRef;
      await created.release();

      const resumeGateway = gatewayWithStore(dir, {
        FAKE_SUPPORT_CLOSE: "1",
        FAKE_SESSION_ID: "fallback-test",
        FAKE_TEXT: "fallback",
      });
      const result = await resumeGateway.resumeSession({
        apiVersion: "v1",
        sessionRef: originalRef,
        fallback: "new-session",
      });
      expect(result.recovery).toBe("fallback-new-session");
      expect(result.requestedSessionRef).toBe(originalRef);
      expect(result.session.sessionRef).not.toBe(originalRef);

      const promptResult = await result.session.prompt({
        prompt: "test",
        timeoutMs: 2_000,
      });
      expect(promptResult).toMatchObject({
        status: "completed",
        text: "fallback",
      });
      await result.session.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not fall back after recovery succeeds but state refresh fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    const store = new FailSecondSaveStore(dir);
    try {
      const createGateway = gatewayWithStore(
        dir,
        {
          FAKE_ADVERTISE_RESUME: "1",
          FAKE_SESSION_ID: "refresh-failure-test",
        },
        store,
      );
      const created = await createGateway.createSession(
        sessionRequest({ durable: true }),
      );
      const originalRef = created.sessionRef;
      await created.release();

      const resumeGateway = gatewayWithStore(
        dir,
        {
          FAKE_ADVERTISE_RESUME: "1",
          FAKE_KNOWN_SESSIONS: "refresh-failure-test",
        },
        store,
      );
      await expect(
        resumeGateway.resumeSession({
          apiVersion: "v1",
          sessionRef: originalRef,
          fallback: "new-session",
        }),
      ).rejects.toMatchObject({
        code: "protocol_error",
      });
      expect(store.saveCount).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("forgets a durable session reference", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    const store = new SessionStateStore(dir);
    try {
      const gateway = gatewayWithStore(dir, {
        FAKE_ADVERTISE_RESUME: "1",
        FAKE_SESSION_ID: "forget-test",
      });
      const session = await gateway.createSession(
        sessionRequest({ durable: true }),
      );
      await session.release();

      const result = await gateway.forget({
        apiVersion: "v1",
        sessionRef: session.sessionRef,
      });
      expect(result.sessionRef).toBe(session.sessionRef);

      const record = await store.load(session.sessionRef);
      expect(record).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("forgets a non-existent durable session reference idempotently", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    try {
      const gateway = gatewayWithStore(dir);
      const sessionRef = "00000000-0000-4000-a000-000000000099";

      await expect(
        gateway.forget({ apiVersion: "v1", sessionRef }),
      ).resolves.toEqual({
        apiVersion: "v1",
        sessionRef,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stateless run never writes to the session store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    const store = new SessionStateStore(dir);
    try {
      const gateway = gatewayWithStore(dir, {
        FAKE_TEXT: "stateless",
      });
      const result = await gateway.run(request());
      expect(result).toMatchObject({
        status: "completed",
        text: "stateless",
      });
      const record = await store.load(
        typeof result.sessionRef === "string" ? result.sessionRef : "none",
      );
      expect(record).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
    timeoutMs: 5_000,
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
    timeoutMs: 2_000,
    ...overrides,
  };
}

function gatewayWithStore(
  dir: string,
  env: NodeJS.ProcessEnv = {},
  store = new SessionStateStore(dir),
): AcpAgentGateway {
  const definitions = Object.fromEntries(
    (["opencode", "claude", "codex"] as const).map((agent) => [
      agent,
      definition(agent, env),
    ]),
  ) as Record<AgentName, AdapterDefinition>;
  const registry = new AgentRegistry(definitions);
  return new AcpAgentGateway(new SessionManager(registry), store, registry);
}

class FailSecondSaveStore extends SessionStateStore {
  saveCount = 0;

  override async save(record: SessionRecord): Promise<void> {
    this.saveCount += 1;
    if (this.saveCount === 2) {
      throw new Error("state refresh failed");
    }
    await super.save(record);
  }
}

class FailOnceRemoveStore extends SessionStateStore {
  #failed = false;

  override async remove(sessionRef: string): Promise<void> {
    if (!this.#failed) {
      this.#failed = true;
      throw new Error("state cleanup failed");
    }
    await super.remove(sessionRef);
  }
}

class CountReleaseLeaseStore extends SessionStateStore {
  releaseLeaseCount = 0;

  override async releaseLease(
    lease: Parameters<SessionStateStore["releaseLease"]>[0],
  ): Promise<void> {
    this.releaseLeaseCount += 1;
    await super.releaseLease(lease);
  }
}

function gatewayWithStoreAltered(
  dir: string,
  env: NodeJS.ProcessEnv = {},
): AcpAgentGateway {
  const definitions = Object.fromEntries(
    (["opencode", "claude", "codex"] as const).map((agent) => [
      agent,
      alteredDefinition(agent, env),
    ]),
  ) as Record<AgentName, AdapterDefinition>;
  const registry = new AgentRegistry(definitions);
  return new AcpAgentGateway(
    new SessionManager(registry),
    new SessionStateStore(dir),
    registry,
  );
}

function alteredDefinition(
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
      sandboxWritablePaths: ["/incompatible"],
      env,
    };
  }
  return definition(agent, env);
}

function registryWithMissingOpenCode(): AgentRegistry {
  const definitions = Object.fromEntries(
    (["opencode", "claude", "codex"] as const).map((agent) => [
      agent,
      definition(agent, {}),
    ]),
  ) as Record<AgentName, AdapterDefinition>;
  definitions.opencode = {
    ...definitions.opencode,
    command: "missing-opencode-adapter",
  };
  return new AgentRegistry(definitions);
}
