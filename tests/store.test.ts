import { chmod, mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStateStore, type SessionRecord } from "../src/store.js";

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    schemaVersion: 1,
    sessionRef: "00000000-0000-4000-a000-000000000001",
    acpSessionId: "fake-session",
    agent: "opencode",
    cwd: "/home/test/workspace",
    permissionPolicy: "best-effort-read-only",
    model: "test-model",
    adapterFingerprint: "abc123",
    capabilitySnapshot: {
      loadSession: true,
      closeSession: true,
      listSessions: false,
      resumeSession: true,
    },
    lifecycle: "active",
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("SessionStateStore", () => {
  it("rejects an explicit relative state directory", () => {
    expect(() => new SessionStateStore(".")).toThrow(
      "Session state directory must be an absolute path",
    );
  });

  it("rejects a relative state directory from the environment", () => {
    const previous = process.env.ACP_AGENT_GATEWAY_STATE_DIR;
    process.env.ACP_AGENT_GATEWAY_STATE_DIR = ".";
    try {
      expect(() => new SessionStateStore()).toThrow(
        "Session state directory must be an absolute path",
      );
    } finally {
      if (previous === undefined) {
        delete process.env.ACP_AGENT_GATEWAY_STATE_DIR;
      } else {
        process.env.ACP_AGENT_GATEWAY_STATE_DIR = previous;
      }
    }
  });

  it("saves and loads a valid record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    const store = new SessionStateStore(dir);
    try {
      const rec = record();
      await store.save(rec);

      const loaded = await store.load(rec.sessionRef);
      expect(loaded).toEqual(rec);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined for non-existent session reference", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    const store = new SessionStateStore(dir);
    try {
      const loaded = await store.load("00000000-0000-4000-a000-000000000002");
      expect(loaded).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("removes a record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    const store = new SessionStateStore(dir);
    try {
      const rec = record();
      await store.save(rec);
      await store.remove(rec.sessionRef);

      const loaded = await store.load(rec.sessionRef);
      expect(loaded).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not throw when removing a non-existent record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    const store = new SessionStateStore(dir);
    try {
      await expect(
        store.remove("00000000-0000-4000-a000-000000000002"),
      ).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid session ref format", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    const store = new SessionStateStore(dir);
    try {
      await expect(
        store.save(record({ sessionRef: "../etc" })),
      ).rejects.toThrow("Invalid session ref format");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects corrupted JSON as invalid session state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    const store = new SessionStateStore(dir);
    const sessionRef = "00000000-0000-4000-a000-000000000001";
    try {
      await store.save(record({ sessionRef }));
      const { writeFile } = await import("node:fs/promises");
      const file = join(dir, "sessions", `${sessionRef}.json`);
      await writeFile(file, "not-json", { mode: 0o600 });
      await expect(store.load(sessionRef)).rejects.toMatchObject({
        code: "invalid_session_state",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects an invalid zod shape as invalid session state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    const store = new SessionStateStore(dir);
    const sessionRef = "00000000-0000-4000-a000-000000000001";
    try {
      await store.save(record({ sessionRef }));
      const { writeFile } = await import("node:fs/promises");
      const file = join(dir, "sessions", `${sessionRef}.json`);
      await writeFile(
        file,
        JSON.stringify({ schemaVersion: 1, sessionRef: "bad" }),
        { mode: 0o600 },
      );
      await expect(store.load(sessionRef)).rejects.toMatchObject({
        code: "invalid_session_state",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("persists records without sensitive data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    const store = new SessionStateStore(dir);
    try {
      const rec = record();
      await store.save(rec);

      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(
        join(dir, "sessions", `${rec.sessionRef}.json`),
        "utf8",
      );
      const parsed = JSON.parse(raw);

      expect(parsed).not.toHaveProperty("prompt");
      expect(parsed).not.toHaveProperty("text");
      expect(parsed).not.toHaveProperty("token");
      expect(parsed).not.toHaveProperty("apiKey");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects records with extra fields before persisting them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    const store = new SessionStateStore(dir);
    try {
      await expect(
        store.save({
          ...record(),
          prompt: "must not persist",
        } as SessionRecord),
      ).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects records with a relative workspace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    const store = new SessionStateStore(dir);
    try {
      await expect(store.save(record({ cwd: "." }))).rejects.toThrow(
        "cwd must be an absolute path",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects records with invalid timestamps", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    const store = new SessionStateStore(dir);
    try {
      await expect(
        store.save(record({ createdAt: "not-a-timestamp" })),
      ).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("overwrites an existing record on save", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    const store = new SessionStateStore(dir);
    try {
      const rec1 = record();
      await store.save(rec1);

      const rec2 = record({ model: "updated-model" });
      await store.save(rec2);

      const loaded = await store.load(rec1.sessionRef);
      expect(loaded).toEqual(rec2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("creates session directories with user-only permissions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    const store = new SessionStateStore(dir);
    try {
      await store.save(record());
      const stats = await stat(join(dir, "sessions"));
      expect(stats.mode & 0o077).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes record files with user-only permissions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    const store = new SessionStateStore(dir);
    try {
      const rec = record();
      await store.save(rec);
      const stats = await stat(join(dir, "sessions", `${rec.sessionRef}.json`));
      expect(stats.mode & 0o077).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("tightens record permissions before loading existing state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    const store = new SessionStateStore(dir);
    try {
      const rec = record();
      const file = join(dir, "sessions", `${rec.sessionRef}.json`);
      await store.save(rec);
      await chmod(file, 0o666);

      await expect(store.load(rec.sessionRef)).resolves.toEqual(rec);
      const stats = await stat(file);
      expect(stats.mode & 0o077).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("tightens directory permissions before loading existing state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    const store = new SessionStateStore(dir);
    try {
      const rec = record();
      const sessionsDir = join(dir, "sessions");
      await store.save(rec);
      await chmod(sessionsDir, 0o777);

      await expect(store.load(rec.sessionRef)).resolves.toEqual(rec);
      const stats = await stat(sessionsDir);
      expect(stats.mode & 0o077).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("tightens permissions on pre-existing loose directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    const sessionsDir = join(dir, "sessions");
    await mkdir(sessionsDir, { mode: 0o755 });
    const store = new SessionStateStore(dir);
    try {
      await store.save(record());
      const stats = await stat(sessionsDir);
      expect(stats.mode & 0o077).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("handles concurrent atomic writes to the same session ref", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    const store = new SessionStateStore(dir);
    const sessionRef = "00000000-0000-4000-a000-000000000010";
    try {
      await Promise.all([
        store.save(record({ sessionRef, model: "concurrent-a" })),
        store.save(record({ sessionRef, model: "concurrent-b" })),
      ]);
      const loaded = await store.load(sessionRef);
      expect(loaded).toBeDefined();
      expect(loaded!.model).toBeOneOf(["concurrent-a", "concurrent-b"]);
      expect(loaded!.sessionRef).toBe(sessionRef);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a second holder while a lease owner is alive", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    const store = new SessionStateStore(dir);
    try {
      const lease = await store.acquireLease(record().sessionRef);

      await expect(
        store.acquireLease(record().sessionRef),
      ).rejects.toMatchObject({
        code: "invalid_session_state",
      });

      await store.releaseLease(lease);
      const nextLease = await store.acquireLease(record().sessionRef);
      await store.releaseLease(nextLease);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("replaces a stale lease owned by a dead process", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    const store = new SessionStateStore(dir);
    const rec = record();
    try {
      await store.save(rec);
      await writeFile(
        join(dir, "sessions", `${rec.sessionRef}.lease.json`),
        JSON.stringify({
          schemaVersion: 1,
          sessionRef: rec.sessionRef,
          leaseId: "00000000-0000-4000-a000-000000000099",
          pid: 2_147_483_647,
          createdAt: new Date().toISOString(),
        }),
        { mode: 0o600 },
      );

      const lease = await store.acquireLease(rec.sessionRef);
      expect(lease.pid).toBe(process.pid);
      expect(lease.leaseId).not.toBe("00000000-0000-4000-a000-000000000099");
      await store.releaseLease(lease);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not release a lease after ownership changes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    const store = new SessionStateStore(dir);
    const rec = record();
    const leaseFile = join(dir, "sessions", `${rec.sessionRef}.lease.json`);
    try {
      const lease = await store.acquireLease(rec.sessionRef);
      await unlink(leaseFile);
      await writeFile(
        leaseFile,
        JSON.stringify({
          schemaVersion: 1,
          sessionRef: rec.sessionRef,
          leaseId: "00000000-0000-4000-a000-000000000099",
          pid: process.pid,
          createdAt: new Date().toISOString(),
        }),
        { mode: 0o600 },
      );

      await expect(store.releaseLease(lease)).rejects.toMatchObject({
        code: "invalid_session_state",
      });
      await expect(store.acquireLease(rec.sessionRef)).rejects.toMatchObject({
        code: "invalid_session_state",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("allows only one concurrent stale lease reclaimer to acquire ownership", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    const firstStore = new SessionStateStore(dir);
    const secondStore = new SessionStateStore(dir);
    const rec = record();
    try {
      await firstStore.save(rec);
      await writeFile(
        join(dir, "sessions", `${rec.sessionRef}.lease.json`),
        JSON.stringify({
          schemaVersion: 1,
          sessionRef: rec.sessionRef,
          leaseId: "00000000-0000-4000-a000-000000000099",
          pid: 2_147_483_647,
          createdAt: new Date().toISOString(),
        }),
        { mode: 0o600 },
      );

      const results = await Promise.allSettled([
        firstStore.acquireLease(rec.sessionRef),
        secondStore.acquireLease(rec.sessionRef),
      ]);
      const acquired = results.filter(
        (result) => result.status === "fulfilled",
      );
      const rejected = results.filter((result) => result.status === "rejected");

      expect(acquired).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toMatchObject({
        code: "invalid_session_state",
      });
      await firstStore.releaseLease(acquired[0]!.value);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails closed while a stale lease reclaim marker remains", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    const store = new SessionStateStore(dir);
    const rec = record();
    try {
      await store.save(rec);
      await writeFile(
        join(dir, "sessions", `${rec.sessionRef}.reclaim.json`),
        "{}",
        { mode: 0o600 },
      );

      await expect(store.acquireLease(rec.sessionRef)).rejects.toMatchObject({
        code: "invalid_session_state",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
