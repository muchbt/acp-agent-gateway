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
  }

  async initialize() {
    if (process.env.FAKE_HANG_INITIALIZE === "1") {
      return new Promise(() => undefined);
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        ...(process.env.FAKE_SUPPORT_CLOSE === "1"
          ? { sessionCapabilities: { close: {} } }
          : {}),
      },
      authMethods: [],
    };
  }

  async newSession() {
    return {
      sessionId: "fake-session",
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
      return { stopReason: "end_turn" };
    }

    await this.sendText(
      sessionId,
      process.env.FAKE_ECHO_MODEL === "1"
        ? this.model
        : process.env.FAKE_ECHO_TURN === "1"
          ? `turn:${this.turn}`
          : (process.env.FAKE_TEXT ?? "fake response"),
    );
    return { stopReason: "end_turn" };
  }

  async cancel() {
    this.cancelPending?.();
  }

  async closeSession() {
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
