import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const chmodMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  chmodMock.mockImplementation(actual.chmod);
  return { ...actual, chmod: chmodMock };
});

import { SessionStateStore, type SessionRecord } from "../src/store.js";

describe("SessionStateStore directory permissions", () => {
  it("rejects saves when an existing state directory cannot be tightened", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    await mkdir(join(dir, "sessions"), { mode: 0o777 });
    chmodMock.mockRejectedValueOnce(new Error("chmod denied"));
    const store = new SessionStateStore(dir);

    try {
      await expect(store.save(record())).rejects.toThrow("chmod denied");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects loads when existing record permissions cannot be tightened", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-agent-gateway-"));
    const store = new SessionStateStore(dir);
    const rec = record();
    const file = join(dir, "sessions", `${rec.sessionRef}.json`);

    try {
      await store.save(rec);
      await chmod(file, 0o666);
      chmodMock.mockRejectedValueOnce(new Error("chmod denied"));

      await expect(store.load(rec.sessionRef)).rejects.toThrow("chmod denied");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function record(): SessionRecord {
  return {
    schemaVersion: 1,
    sessionRef: "00000000-0000-4000-a000-000000000001",
    acpSessionId: "fake-session",
    agent: "opencode",
    cwd: "/home/test/workspace",
    permissionPolicy: "best-effort-read-only",
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
  };
}
