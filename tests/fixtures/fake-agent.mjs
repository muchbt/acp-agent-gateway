import { Readable, Writable } from "node:stream";
import { appendFile } from "node:fs/promises";
import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from "@agentclientprotocol/sdk";

class FakeAgent {
  constructor(connection) {
    this.connection = connection;
    this.cancelPending = undefined;
    this.model = "default-model";
    this.turn = 0;

    const sessions = [];
    const known = process.env.FAKE_KNOWN_SESSIONS;
    if (known) {
      sessions.push(...known.split(",").filter(Boolean));
    }
    this.#sessions = sessions;

    this.#advertiseResume = process.env.FAKE_ADVERTISE_RESUME === "1";
    this.#advertiseLoad = process.env.FAKE_ADVERTISE_LOAD === "1";
    this.#advertiseClose = process.env.FAKE_SUPPORT_CLOSE === "1";
    this.#suppressResume = process.env.FAKE_SUPPRESS_RESUME === "1";
    this.#suppressLoad = process.env.FAKE_SUPPRESS_LOAD === "1";
    this.#replayChunks = process.env.FAKE_REPLAY_CHUNKS
      ? Number.parseInt(process.env.FAKE_REPLAY_CHUNKS, 10)
      : 0;
    this.#pendingResolve = undefined;

    if (process.env.FAKE_HANG_RESUME === "1") {
      this.#pendingResolve = new Promise((resolve) => {
        this.resolveResume = resolve;
      });
    }
  }

  #sessions;
  #advertiseResume;
  #advertiseLoad;
  #advertiseClose;
  #suppressResume;
  #suppressLoad;
  #replayChunks;
  #pendingResolve;

  async initialize() {
    if (process.env.FAKE_HANG_INITIALIZE === "1") {
      return new Promise(() => undefined);
    }
    const sessionCaps = {};
    if (this.#advertiseResume) {
      sessionCaps.resume = {};
    }
    if (this.#advertiseClose) {
      sessionCaps.close = {};
    }
    if (process.env.FAKE_ADVERTISE_LIST === "1") {
      sessionCaps.list = {};
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: this.#advertiseLoad,
        ...(Object.keys(sessionCaps).length > 0
          ? { sessionCapabilities: sessionCaps }
          : {}),
      },
      authMethods: [],
    };
  }

  async newSession() {
    const sessionId = process.env.FAKE_SESSION_ID ?? "fake-session";
    this.#sessions.push(sessionId);
    return {
      sessionId,
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "default-model",
          options: [
            { value: "default-model", name: "Default" },
            { value: "test-model", name: "Test" },
          ],
        },
      ],
    };
  }

  async setSessionConfigOption({ value }) {
    this.model = value;
    return { configOptions: [] };
  }

  async prompt({ sessionId }) {
    this.turn += 1;
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "secret thought" },
      },
    });

    if (process.env.FAKE_PERMISSION_KIND) {
      const toolCall = {
        toolCallId: "fake-tool",
        title: "sensitive title",
        kind: process.env.FAKE_PERMISSION_KIND,
        status: "pending",
      };
      await this.connection.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "tool_call", ...toolCall },
      });
      const permission = await this.connection.requestPermission({
        sessionId,
        toolCall,
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      });
      const selected =
        permission.outcome.outcome === "selected"
          ? permission.outcome.optionId
          : "cancelled";
      await this.sendText(sessionId, `permission:${selected}`);
    }

    if (
      process.env.FAKE_HANG === "1" ||
      (process.env.FAKE_HANG_FIRST === "1" && this.turn === 1)
    ) {
      return new Promise((resolve) => {
        this.cancelPending = () => resolve({ stopReason: "cancelled" });
      });
    }

    if (process.env.FAKE_LATE_TEXT === "1") {
      setTimeout(() => {
        void this.sendText(sessionId, process.env.FAKE_TEXT ?? "fake response");
      }, 30);
      return { stopReason: process.env.FAKE_STOP_REASON ?? "end_turn" };
    }

    if (process.env.FAKE_EMPTY_TEXT === "1") {
      await this.connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "internal thought" },
        },
      });
      return { stopReason: process.env.FAKE_STOP_REASON ?? "end_turn" };
    }

    await this.sendText(
      sessionId,
      process.env.FAKE_ECHO_MODEL === "1"
        ? this.model
        : process.env.FAKE_ECHO_TURN === "1"
          ? `turn:${this.turn}`
          : (process.env.FAKE_TEXT ?? "fake response"),
    );
    return { stopReason: process.env.FAKE_STOP_REASON ?? "end_turn" };
  }

  async cancel() {
    this.resolveResume?.({ stopReason: "cancelled" });
    this.cancelPending?.();
  }

  async resumeSession({ sessionId }) {
    if (this.#pendingResolve) {
      return this.#pendingResolve;
    }
    if (this.#suppressResume) {
      throw new Error("resumeSession not supported");
    }
    if (!this.#sessions.includes(sessionId)) {
      throw new Error("session not found");
    }
    return {};
  }

  async loadSession({ sessionId }) {
    if (this.#suppressLoad) {
      throw new Error("loadSession not supported");
    }
    if (!this.#sessions.includes(sessionId)) {
      throw new Error("session not found");
    }
    for (let i = 0; i < this.#replayChunks; i++) {
      await this.connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `replay:${i + 1}` },
        },
      });
    }
    return {};
  }

  async closeSession() {
    if (process.env.FAKE_CLOSE_ERROR === "1") {
      throw new Error("close failed");
    }
    if (process.env.FAKE_CLOSE_MARKER) {
      await appendFile(process.env.FAKE_CLOSE_MARKER, "closed\n");
    }
  }

  async sendText(sessionId, text) {
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    });
  }
}

const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin);
new AgentSideConnection(
  (connection) => new FakeAgent(connection),
  ndJsonStream(input, output),
);
