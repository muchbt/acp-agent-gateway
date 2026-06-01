import { describe, expect, it } from "vitest";
import type { AgentName } from "../src/contracts.js";
import { AgentRegistry, type AdapterDefinition } from "../src/registry.js";

describe("AgentRegistry", () => {
  it("resolves OpenCode from PATH", async () => {
    const adapter = await new AgentRegistry().resolve("opencode");

    expect(adapter.agent).toBe("opencode");
    expect(adapter.args).toEqual(["acp"]);
    expect(adapter.executable).toMatch(/opencode(?:\.exe)?$/);
    expect(adapter.fingerprint).toHaveLength(64);
  });

  it("rejects reserved agents", async () => {
    const definitions = Object.fromEntries(
      (["opencode", "claude", "codex"] as const).map((agent) => [
        agent,
        definition(agent, agent === "claude" ? "reserved" : "verified"),
      ]),
    ) as Record<AgentName, AdapterDefinition>;

    await expect(
      new AgentRegistry(definitions).resolve("claude"),
    ).rejects.toMatchObject({
      code: "unsupported_agent",
    });
  });
});

function definition(
  agent: AgentName,
  support: AdapterDefinition["support"],
): AdapterDefinition {
  return {
    agent,
    support,
    command: agent,
    args: [],
    installHint: "test",
  };
}
