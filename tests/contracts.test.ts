import { describe, expect, it } from "vitest";
import {
  CliRunInputSchema,
  CreateSessionRequestSchema,
  PromptRequestSchema,
  StopReasonSchema,
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
      durable: false,
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

describe("StopReasonSchema", () => {
  it("accepts public ACP and gateway stop reasons", () => {
    expect(StopReasonSchema.parse("empty_response")).toBe("empty_response");
    expect(StopReasonSchema.parse("max_tokens")).toBe("max_tokens");
    expect(StopReasonSchema.parse("max_turn_requests")).toBe(
      "max_turn_requests",
    );
    expect(StopReasonSchema.parse("refusal")).toBe("refusal");
    expect(() => StopReasonSchema.parse("future_reason")).toThrow();
  });
});
