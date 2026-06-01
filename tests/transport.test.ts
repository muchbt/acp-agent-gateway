import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { PermissionPolicy } from "../src/contracts.js";
import type { ResolvedAdapter } from "../src/registry.js";
import {
  resolveAdapterLaunch,
  spawnAdapterTransport,
} from "../src/transport.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("resolveAdapterLaunch", () => {
  it("launches best-effort policies without an OS sandbox", async () => {
    const adapter = shellAdapter(["-c", "printf direct"]);

    await expect(
      resolveAdapterLaunch(adapter, process.cwd(), "best-effort-read-only"),
    ).resolves.toEqual({
      executable: "/bin/sh",
      args: ["-c", "printf direct"],
    });
  });

  it("prevents workspace and outside writes under strict-read-only", async () => {
    const result = await executeSandboxProbe("strict-read-only");

    expect(result).toBe("1 1");
  });

  it("allows workspace writes only under workspace-write", async () => {
    const result = await executeSandboxProbe("workspace-write");

    expect(result).toBe("0 1");
  });

  it("terminates adapter descendant processes", async () => {
    const workspace = await temporaryDirectory(".adapter-process-group-");
    const marker = join(workspace, "pid");
    const adapter = shellAdapter([
      "-c",
      `sleep 30 & printf '%s' "$!" > ${JSON.stringify(marker)}; wait`,
    ]);
    const transport = await spawnAdapterTransport(
      adapter,
      workspace,
      "best-effort-read-only",
    );
    const pid = Number.parseInt(await waitForFile(marker), 10);

    await transport.terminate();

    expect(isProcessAlive(pid)).toBe(false);
  });
});

async function executeSandboxProbe(
  permissionPolicy: PermissionPolicy,
): Promise<string> {
  const workspace = await temporaryDirectory(".sandbox-workspace-");
  const outside = await temporaryDirectory(".sandbox-outside-");
  const adapter = shellAdapter([
    "-c",
    [
      'touch "$1/inside" 2>/dev/null',
      "inside=$?",
      'touch "$2/outside" 2>/dev/null',
      "outside=$?",
      'printf "%s %s" "$inside" "$outside"',
    ].join("\n"),
    "sandbox-probe",
    workspace,
    outside,
  ]);
  const launch = await resolveAdapterLaunch(
    adapter,
    workspace,
    permissionPolicy,
  );
  const { stdout } = await execFileAsync(launch.executable, launch.args);
  return stdout;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(process.cwd(), prefix));
  directories.push(directory);
  return directory;
}

function shellAdapter(args: string[]): ResolvedAdapter {
  return {
    agent: "opencode",
    support: "verified",
    command: "sh",
    executable: "/bin/sh",
    args,
    installHint: "test",
    fingerprint: "test",
  };
}

async function waitForFile(path: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
