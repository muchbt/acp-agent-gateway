import { describe, expect, it } from "vitest";
import {
  CliRunInputSchema,
  CreateSessionRequestSchema,
  PromptRequestSchema,
} from "../src/contracts.js";

describe("CliRunInputSchema", () => {
  it("applies bounded defaults", () => {
    const input = CliRunInputSchema.parse({
      apiVersion: "v1",
      prompt: "inspect the repository",
    });

    expect(input).toEqual({
      apiVersion: "v1",
      prompt: "inspect the repository",
      permissionPolicy: "best-effort-read-only",
      timeoutMs: 900_000,
      gracePeriodMs: 5_000,
      includeEvents: false,
    });
  });

  it("rejects unknown fields and missing versions", () => {
    expect(() =>
      CliRunInputSchema.parse({ prompt: "x", extra: true }),
    ).toThrow();
  });
});

describe("stateful session schemas", () => {
  it("applies managed session defaults", () => {
    const input = CreateSessionRequestSchema.parse({
      apiVersion: "v1",
      agent: "opencode",
      cwd: process.cwd(),
    });

    expect(input).toEqual({
      apiVersion: "v1",
      agent: "opencode",
      cwd: process.cwd(),
      permissionPolicy: "best-effort-read-only",
      timeoutMs: 900_000,
    });
  });

  it("applies prompt turn defaults", () => {
    const input = PromptRequestSchema.parse({ prompt: "continue analysis" });

    expect(input).toEqual({
      prompt: "continue analysis",
      timeoutMs: 900_000,
      gracePeriodMs: 5_000,
      includeEvents: false,
    });
  });
});
