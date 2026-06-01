import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

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

async function runCli(args: string[]) {
  try {
    return await execFileAsync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", ...args],
      { cwd: process.cwd() },
    );
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "stdout" in error &&
      "stderr" in error
    ) {
      return {
        stdout: String(error.stdout),
        stderr: String(error.stderr),
      };
    }
    throw error;
  }
}
