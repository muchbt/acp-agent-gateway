import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ToolKind,
} from "@agentclientprotocol/sdk";
import type { PermissionPolicy } from "./contracts.js";

export type InteractiveApproval = (
  request: RequestPermissionRequest,
) => Promise<string>;

export interface PermissionDecision {
  response: RequestPermissionResponse;
  decision: "allowed" | "rejected" | "cancelled";
}

const READ_ONLY_ALLOWED = new Set<ToolKind>(["read", "search", "think"]);
const WORKSPACE_WRITE_ALLOWED = new Set<ToolKind>([
  "read",
  "search",
  "think",
  "edit",
  "delete",
  "move",
  "execute",
]);

export async function decidePermission(
  request: RequestPermissionRequest,
  policy: PermissionPolicy,
  interactiveApproval?: InteractiveApproval,
): Promise<PermissionDecision> {
  if (interactiveApproval) {
    const optionId = await interactiveApproval(request);
    if (!request.options.some((option) => option.optionId === optionId)) {
      return cancelled();
    }
    return selected(optionId, isAllowOption(request.options, optionId));
  }

  const kind = request.toolCall.kind ?? "other";
  const allow = shouldAllow(kind, policy);
  const option = pickOption(request.options, allow);
  if (!option) {
    return cancelled();
  }
  return selected(option.optionId, allow);
}

function shouldAllow(kind: ToolKind, policy: PermissionPolicy): boolean {
  switch (policy) {
    case "approve-all":
      return true;
    case "deny-all":
      return false;
    case "best-effort-read-only":
    case "strict-read-only":
      return READ_ONLY_ALLOWED.has(kind);
    case "best-effort-workspace-write":
    case "workspace-write":
      return WORKSPACE_WRITE_ALLOWED.has(kind);
  }
}

function pickOption(
  options: PermissionOption[],
  allow: boolean,
): PermissionOption | undefined {
  const kinds = allow
    ? (["allow_once", "allow_always"] as const)
    : (["reject_once", "reject_always"] as const);
  return kinds
    .map((kind) => options.find((option) => option.kind === kind))
    .find((option) => option !== undefined);
}

function isAllowOption(options: PermissionOption[], optionId: string): boolean {
  const option = options.find((candidate) => candidate.optionId === optionId);
  return option?.kind === "allow_once" || option?.kind === "allow_always";
}

function selected(optionId: string, allow: boolean): PermissionDecision {
  return {
    response: { outcome: { outcome: "selected", optionId } },
    decision: allow ? "allowed" : "rejected",
  };
}

function cancelled(): PermissionDecision {
  return {
    response: { outcome: { outcome: "cancelled" } },
    decision: "cancelled",
  };
}
