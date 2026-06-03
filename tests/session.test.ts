import { ndJsonStream } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import { AgentRegistry, type AdapterDefinition } from "../src/registry.js";
import { SessionManager } from "../src/session.js";
import type { AdapterTransport, TransportFactory } from "../src/transport.js";

describe("SessionManager", () => {
  it("terminates a recovery probe cancelled while its transport is starting", async () => {
    const controller = new AbortController();
    const transport = hangingTransport();
    let resolveTransport!: (transport: AdapterTransport) => void;
    let transportRequested!: () => void;
    const requested = new Promise<void>((resolve) => {
      transportRequested = resolve;
    });
    const pendingTransport = new Promise<AdapterTransport>((resolve) => {
      resolveTransport = resolve;
    });
    const transportFactory: TransportFactory = async () => {
      transportRequested();
      return pendingTransport;
    };
    const manager = new SessionManager(registry(), transportFactory);

    const probe = manager.probe(
      "opencode",
      "best-effort-read-only",
      process.cwd(),
      controller.signal,
    );
    await requested;
    controller.abort();
    resolveTransport(transport);

    try {
      await expect(
        Promise.race([
          probe,
          delay(100).then(() => {
            throw new Error("probe did not settle after cancellation");
          }),
        ]),
      ).rejects.toMatchObject({ code: "cancelled" });
      expect(transport.terminationCount()).toBe(1);
    } finally {
      transport.closeOutput();
      await probe.catch(() => undefined);
    }
  });

  it("rejects a relative recovery workspace before starting a transport", async () => {
    const transportFactory: TransportFactory = vi.fn(async () =>
      hangingTransport(),
    );
    const manager = new SessionManager(registry(), transportFactory);

    await expect(
      manager.probe("opencode", "best-effort-read-only", "."),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(transportFactory).not.toHaveBeenCalled();
  });
});

function registry(): AgentRegistry {
  const definition: AdapterDefinition = {
    agent: "opencode",
    support: "verified",
    command: "node",
    args: [],
    installHint: "test",
  };
  return new AgentRegistry({
    opencode: definition,
    claude: { ...definition, agent: "claude", support: "reserved" },
    codex: { ...definition, agent: "codex", support: "reserved" },
  });
}

function hangingTransport(): AdapterTransport & {
  closeOutput(): void;
  terminationCount(): number;
} {
  let closeOutput!: () => void;
  let terminations = 0;
  const input = new WritableStream<Uint8Array>();
  const output = new ReadableStream<Uint8Array>({
    start(controller) {
      closeOutput = () => controller.close();
    },
  });

  return {
    stream: ndJsonStream(input, output),
    closeOutput,
    terminationCount: () => terminations,
    async terminate() {
      terminations += 1;
    },
  };
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
