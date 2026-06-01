import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ndJsonStream, type Stream } from "@agentclientprotocol/sdk";
import type { PermissionPolicy } from "./contracts.js";
import { findExecutableOnPath, type ResolvedAdapter } from "./registry.js";
import { GatewayError } from "./errors.js";

export interface AdapterTransport {
  stream: Stream;
  terminate(): Promise<void>;
}

export type TransportFactory = (
  adapter: ResolvedAdapter,
  cwd: string,
  permissionPolicy: PermissionPolicy,
) => Promise<AdapterTransport>;

export const spawnAdapterTransport: TransportFactory = async (
  adapter,
  cwd,
  permissionPolicy,
) => {
  let child: ChildProcessWithoutNullStreams;
  try {
    const launch = await resolveAdapterLaunch(adapter, cwd, permissionPolicy);
    child = spawn(launch.executable, launch.args, {
      cwd,
      detached: process.platform !== "win32",
      env: { ...process.env, ...adapter.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    throw new GatewayError("adapter_spawn_failed", "Failed to spawn adapter", {
      cause: error,
    });
  }

  child.stderr.resume();

  await waitForSpawn(child);

  const input = Writable.toWeb(
    child.stdin,
  ) as unknown as WritableStream<Uint8Array>;
  const output = Readable.toWeb(
    child.stdout,
  ) as unknown as ReadableStream<Uint8Array>;
  return {
    stream: ndJsonStream(input, output),
    async terminate() {
      if (process.platform === "win32") {
        await terminateDirectChild(child);
      } else {
        await terminateProcessGroup(child);
      }
    },
  };
};

export interface AdapterLaunch {
  executable: string;
  args: string[];
}

export async function resolveAdapterLaunch(
  adapter: ResolvedAdapter,
  cwd: string,
  permissionPolicy: PermissionPolicy,
): Promise<AdapterLaunch> {
  if (!isSandboxPolicy(permissionPolicy)) {
    return { executable: adapter.executable, args: adapter.args };
  }
  if (process.platform !== "linux") {
    throw new GatewayError(
      "sandbox_unavailable",
      "Sandbox-backed permission policies currently require Linux",
    );
  }
  const bwrap = await findExecutableOnPath("bwrap");
  if (!bwrap) {
    throw new GatewayError(
      "sandbox_unavailable",
      "Bubblewrap executable was not found on PATH",
    );
  }
  return {
    executable: bwrap,
    args: [
      "--die-with-parent",
      "--new-session",
      "--unshare-all",
      "--share-net",
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--tmpfs",
      "/tmp",
      ...adapterWritableBindings(adapter),
      ...(permissionPolicy === "workspace-write" ? ["--bind", cwd, cwd] : []),
      "--chdir",
      cwd,
      "--",
      adapter.executable,
      ...adapter.args,
    ],
  };
}

function isSandboxPolicy(permissionPolicy: PermissionPolicy): boolean {
  return (
    permissionPolicy === "strict-read-only" ||
    permissionPolicy === "workspace-write"
  );
}

function adapterWritableBindings(adapter: ResolvedAdapter): string[] {
  return (adapter.sandboxWritablePaths ?? []).flatMap((path) => [
    "--bind-try",
    path,
    path,
  ]);
}

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(
        new GatewayError("adapter_spawn_failed", "Failed to spawn adapter", {
          cause: error,
        }),
      );
    };
    const cleanup = () => {
      child.off("spawn", onSpawn);
      child.off("error", onError);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function terminateDirectChild(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await waitForExit(child, 1_000);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await waitForExit(child, 1_000);
  }
}

async function terminateProcessGroup(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  signalProcessGroup(child, "SIGTERM");
  if (await waitForProcessGroupExit(child, 1_000)) {
    return;
  }
  signalProcessGroup(child, "SIGKILL");
  await waitForExit(child, 1_000);
}

function signalProcessGroup(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  if (child.pid === undefined) {
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The adapter process group has already exited.
  }
}

async function waitForProcessGroupExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  const started = Date.now();
  while (isProcessGroupAlive(child) && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isProcessGroupAlive(child);
}

function isProcessGroupAlive(child: ChildProcessWithoutNullStreams): boolean {
  if (child.pid === undefined) {
    return false;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}
