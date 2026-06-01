import { describe, expect, it } from "vitest";
import type {
  RequestPermissionRequest,
  ToolKind,
} from "@agentclientprotocol/sdk";
import { decidePermission } from "../src/permissions.js";

describe("decidePermission", () => {
  it("allows only read-oriented requests under best-effort-read-only", async () => {
    expect(
      (await decidePermission(request("read"), "best-effort-read-only"))
        .decision,
    ).toBe("allowed");
    expect(
      (await decidePermission(request("execute"), "best-effort-read-only"))
        .decision,
    ).toBe("rejected");
  });

  it("allows edits under best-effort-workspace-write", async () => {
    expect(
      (await decidePermission(request("edit"), "best-effort-workspace-write"))
        .decision,
    ).toBe("allowed");
  });

  it("uses matching ACP decisions for sandbox-backed policies", async () => {
    expect(
      (await decidePermission(request("execute"), "strict-read-only")).decision,
    ).toBe("rejected");
    expect(
      (await decidePermission(request("edit"), "workspace-write")).decision,
    ).toBe("allowed");
  });

  it("keeps approve-all and deny-all explicit", async () => {
    expect(
      (await decidePermission(request("other"), "approve-all")).decision,
    ).toBe("allowed");
    expect((await decidePermission(request("read"), "deny-all")).decision).toBe(
      "rejected",
    );
  });

  it("accepts a TypeScript interactive approval callback", async () => {
    const decision = await decidePermission(
      request("execute"),
      "deny-all",
      async () => "allow",
    );

    expect(decision.decision).toBe("allowed");
  });
});

function request(kind: ToolKind): RequestPermissionRequest {
  return {
    sessionId: "test-session",
    toolCall: {
      toolCallId: "tool",
      title: "sensitive title",
      kind,
      status: "pending",
    },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
  };
}
