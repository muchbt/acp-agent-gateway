import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AgentNameSchema,
  PermissionPolicySchema,
  SessionRefSchema,
} from "./contracts.js";
import { GatewayError } from "./errors.js";

const CapabilitySnapshotSchema = z
  .object({
    loadSession: z.boolean(),
    closeSession: z.boolean(),
    listSessions: z.boolean(),
    resumeSession: z.boolean(),
  })
  .strict();

export type CapabilitySnapshot = z.infer<typeof CapabilitySnapshotSchema>;

export const SessionRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    sessionRef: SessionRefSchema,
    acpSessionId: z.string().min(1),
    agent: AgentNameSchema,
    cwd: z.string().min(1).refine(isAbsolute, "cwd must be an absolute path"),
    permissionPolicy: PermissionPolicySchema,
    model: z.string().min(1).optional(),
    adapterFingerprint: z.string().min(1),
    capabilitySnapshot: CapabilitySnapshotSchema,
    lifecycle: z.enum(["active", "closing"]),
    createdAt: z.iso.datetime(),
    lastUsedAt: z.iso.datetime(),
  })
  .strict();

export type SessionRecord = z.infer<typeof SessionRecordSchema>;

export const SessionLeaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    sessionRef: SessionRefSchema,
    leaseId: SessionRefSchema,
    pid: z.number().int().positive(),
    createdAt: z.iso.datetime(),
  })
  .strict();

export type SessionLease = z.infer<typeof SessionLeaseSchema>;

const SESSION_STORE_DIRNAME = "acp-agent-gateway";
const SESSIONS_DIRNAME = "sessions";

function resolveStateDir(): string {
  if (process.env.ACP_AGENT_GATEWAY_STATE_DIR) {
    return process.env.ACP_AGENT_GATEWAY_STATE_DIR;
  }
  const xdg = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(xdg, SESSION_STORE_DIRNAME);
}

export class SessionStateStore {
  readonly #dir: string;

  constructor(stateDir?: string) {
    const resolvedStateDir = stateDir ?? resolveStateDir();
    if (!isAbsolute(resolvedStateDir)) {
      throw new Error(
        `Session state directory must be an absolute path: ${resolvedStateDir}`,
      );
    }
    this.#dir = join(resolvedStateDir, SESSIONS_DIRNAME);
  }

  async save(record: SessionRecord): Promise<void> {
    const file = this.#recordPath(record.sessionRef);
    const validated = SessionRecordSchema.parse(record);
    await this.#ensureDir();
    const tmp = `${file}.${randomUUID()}.tmp`;
    const payload = JSON.stringify(validated, null, 2);
    try {
      await writeFile(tmp, payload, { mode: 0o600, flag: "wx" });
      await rename(tmp, file);
    } catch (error) {
      await unlink(tmp).catch(() => undefined);
      throw error;
    }
  }

  async load(sessionRef: string): Promise<SessionRecord | undefined> {
    const file = this.#recordPath(sessionRef);
    let raw: string;
    try {
      await this.#ensureDir();
      await ensurePrivateFile(file);
      raw = await readFile(file, "utf8");
    } catch (error) {
      if (isMissing(error)) {
        return undefined;
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw corruptedRecord(sessionRef);
    }
    const result = SessionRecordSchema.safeParse(parsed);
    if (!result.success) {
      throw corruptedRecord(sessionRef);
    }
    return result.data;
  }

  async remove(sessionRef: string): Promise<void> {
    const file = this.#recordPath(sessionRef);
    await this.#ensureDir();
    try {
      await unlink(file);
    } catch (error) {
      if (
        error instanceof Error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }
  }

  async acquireLease(sessionRef: string): Promise<SessionLease> {
    const file = this.#leasePath(sessionRef);
    const reclaimFile = this.#reclaimPath(sessionRef);
    await this.#ensureDir();
    const lease: SessionLease = {
      schemaVersion: 1,
      sessionRef,
      leaseId: randomUUID(),
      pid: process.pid,
      createdAt: new Date().toISOString(),
    };
    const payload = JSON.stringify(lease, null, 2);
    let ownsReclaim = false;
    let acquired = false;

    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (!ownsReclaim && (await fileExists(reclaimFile))) {
          throw leaseHeld(sessionRef, "stale lease reclaim is in progress");
        }
        try {
          await writeFile(file, payload, { mode: 0o600, flag: "wx" });
          acquired = true;
          if (ownsReclaim) {
            await clearReclaimMarker(reclaimFile, file, acquired);
            ownsReclaim = false;
          }
          return lease;
        } catch (error) {
          if (!isAlreadyExists(error)) {
            throw error;
          }
        }

        const existing = await loadLease(file);
        if (!existing) {
          throw leaseHeld(sessionRef, "existing lease is invalid");
        }
        if (isProcessAlive(existing.pid)) {
          throw leaseHeld(sessionRef, `held by process ${existing.pid}`);
        }
        try {
          await writeFile(reclaimFile, JSON.stringify(existing, null, 2), {
            mode: 0o600,
            flag: "wx",
          });
        } catch (error) {
          if (isAlreadyExists(error)) {
            throw leaseHeld(sessionRef, "stale lease reclaim is in progress");
          }
          throw error;
        }
        ownsReclaim = true;

        const current = await loadLease(file);
        if (!current || current.leaseId !== existing.leaseId) {
          throw leaseHeld(sessionRef, "lease ownership changed during reclaim");
        }
        await unlink(file).catch((error: unknown) => {
          if (!isMissing(error)) {
            throw error;
          }
        });
      }

      throw leaseHeld(sessionRef, "lease could not be acquired");
    } catch (error) {
      if (ownsReclaim) {
        await clearReclaimMarker(reclaimFile, file, acquired);
      }
      throw error;
    }
  }

  async releaseLease(lease: SessionLease): Promise<void> {
    const validated = SessionLeaseSchema.parse(lease);
    const file = this.#leasePath(validated.sessionRef);
    const existing = await loadLease(file);
    if (!existing) {
      return;
    }
    if (existing.leaseId !== validated.leaseId) {
      throw leaseHeld(validated.sessionRef, "lease ownership has changed");
    }
    await unlink(file).catch((error: unknown) => {
      if (!isMissing(error)) {
        throw error;
      }
    });
  }

  #recordPath(sessionRef: string): string {
    if (!SessionRefSchema.safeParse(sessionRef).success) {
      throw new Error(`Invalid session ref format: ${sessionRef}`);
    }
    return join(this.#dir, `${sessionRef}.json`);
  }

  #leasePath(sessionRef: string): string {
    if (!SessionRefSchema.safeParse(sessionRef).success) {
      throw new Error(`Invalid session ref format: ${sessionRef}`);
    }
    return join(this.#dir, `${sessionRef}.lease.json`);
  }

  #reclaimPath(sessionRef: string): string {
    if (!SessionRefSchema.safeParse(sessionRef).success) {
      throw new Error(`Invalid session ref format: ${sessionRef}`);
    }
    return join(this.#dir, `${sessionRef}.reclaim.json`);
  }

  async #ensureDir(): Promise<void> {
    await mkdir(this.#dir, { mode: 0o700, recursive: true });
    let stats = await lstat(this.#dir);
    if (!stats.isDirectory()) {
      throw new Error(`Session state path is not a directory: ${this.#dir}`);
    }
    if ((stats.mode & 0o077) !== 0) {
      await chmod(this.#dir, 0o700);
      stats = await lstat(this.#dir);
    }
    if ((stats.mode & 0o077) !== 0) {
      throw new Error(`Session state directory is not private: ${this.#dir}`);
    }
  }
}

async function loadLease(file: string): Promise<SessionLease | undefined> {
  let raw: string;
  try {
    await ensurePrivateFile(file);
    raw = await readFile(file, "utf8");
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }
  try {
    return SessionLeaseSchema.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

async function ensurePrivateFile(file: string): Promise<void> {
  let stats = await lstat(file);
  if (!stats.isFile()) {
    throw new Error(`Session state record is not a regular file: ${file}`);
  }
  if ((stats.mode & 0o077) !== 0) {
    await chmod(file, 0o600);
    stats = await lstat(file);
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new Error(`Session state record is not private: ${file}`);
  }
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    error instanceof Error && (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (isMissing(error)) {
      return false;
    }
    throw error;
  }
}

async function clearReclaimMarker(
  reclaimFile: string,
  leaseFile: string,
  removeLeaseOnFailure: boolean,
): Promise<void> {
  try {
    await unlink(reclaimFile);
  } catch (error) {
    if (isMissing(error)) {
      return;
    }
    if (removeLeaseOnFailure) {
      await unlink(leaseFile).catch(() => undefined);
    }
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code === "ESRCH"
    );
  }
}

function leaseHeld(sessionRef: string, detail: string): GatewayError {
  return new GatewayError(
    "invalid_session_state",
    `Session reference is leased and cannot be used: ${sessionRef} (${detail})`,
  );
}

function corruptedRecord(sessionRef: string): GatewayError {
  return new GatewayError(
    "invalid_session_state",
    `Session reference record is corrupted and cannot be used: ${sessionRef}`,
  );
}

export function buildCapabilitySnapshot(params: {
  loadSession: boolean;
  closeAdvertised: boolean;
  listSessions: boolean;
  resumeSession: boolean;
}): CapabilitySnapshot {
  return {
    loadSession: params.loadSession,
    closeSession: params.closeAdvertised,
    listSessions: params.listSessions,
    resumeSession: params.resumeSession,
  };
}
