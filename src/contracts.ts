import { z } from "zod";

export const API_VERSION = "v1" as const;

export const AgentNameSchema = z.enum(["opencode", "claude", "codex"]);
export type AgentName = z.infer<typeof AgentNameSchema>;

export const AgentStopReasonSchema = z.enum([
  "end_turn",
  "cancelled",
  "max_tokens",
  "max_turn_requests",
  "refusal",
]);

export const StopReasonSchema = z.enum([
  ...AgentStopReasonSchema.options,
  "empty_response",
]);
export type StopReason = z.infer<typeof StopReasonSchema>;

export const PermissionPolicySchema = z.enum([
  "best-effort-read-only",
  "best-effort-workspace-write",
  "strict-read-only",
  "workspace-write",
  "approve-all",
  "deny-all",
]);
export type PermissionPolicy = z.infer<typeof PermissionPolicySchema>;

const SessionConfigurationSchema = z
  .object({
    apiVersion: z.literal(API_VERSION),
    model: z.string().min(1).optional(),
    permissionPolicy: PermissionPolicySchema.default("best-effort-read-only"),
  })
  .strict();

const PromptConfigurationSchema = z
  .object({
    prompt: z.string().min(1),
    timeoutMs: z.number().int().positive().default(900_000),
    idleTimeoutMs: z.number().int().positive().optional(),
    gracePeriodMs: z.number().int().nonnegative().default(5_000),
    includeEvents: z.boolean().default(false),
  })
  .strict();

export const CliRunInputSchema = SessionConfigurationSchema.extend(
  PromptConfigurationSchema.shape,
).strict();
export type CliRunInput = z.infer<typeof CliRunInputSchema>;

export const RunRequestSchema = CliRunInputSchema.extend({
  agent: AgentNameSchema,
  cwd: z.string().min(1),
}).strict();
export type RunRequest = z.infer<typeof RunRequestSchema>;
export type RunRequestInput = z.input<typeof RunRequestSchema>;

export const CreateSessionRequestSchema = SessionConfigurationSchema.extend({
  agent: AgentNameSchema,
  cwd: z.string().min(1),
  durable: z.boolean().default(false),
  timeoutMs: z.number().int().positive().default(900_000),
  idleTimeoutMs: z.number().int().positive().optional(),
}).strict();
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;
export type CreateSessionRequestInput = z.input<
  typeof CreateSessionRequestSchema
>;

export const PromptRequestSchema = PromptConfigurationSchema;
export type PromptRequest = z.infer<typeof PromptRequestSchema>;
export type PromptRequestInput = z.input<typeof PromptRequestSchema>;

export const RecoveryMetaSchema = z.enum(["resumed", "fallback-new-session"]);
export type RecoveryMeta = z.infer<typeof RecoveryMetaSchema>;

export const SessionRefSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    "sessionRef must be a UUID",
  );

export const ResumeSessionRequestSchema = z
  .object({
    apiVersion: z.literal(API_VERSION),
    sessionRef: SessionRefSchema,
    fallback: z.enum(["new-session"]).optional(),
  })
  .strict();
export type ResumeSessionRequest = z.infer<typeof ResumeSessionRequestSchema>;
export type ResumeSessionRequestInput = z.input<
  typeof ResumeSessionRequestSchema
>;

export const ForgetRequestSchema = z
  .object({
    apiVersion: z.literal(API_VERSION),
    sessionRef: SessionRefSchema,
  })
  .strict();
export type ForgetRequest = z.infer<typeof ForgetRequestSchema>;
export type ForgetRequestInput = z.input<typeof ForgetRequestSchema>;

export const GatewayErrorCodeSchema = z.enum([
  "invalid_request",
  "unsupported_agent",
  "adapter_not_found",
  "adapter_spawn_failed",
  "sandbox_unavailable",
  "protocol_error",
  "timeout",
  "idle_timeout",
  "cancelled",
  "unsupported_permission_policy",
  "unsupported_model",
  "unsupported_session_close",
  "unsupported_session_recovery",
  "incompatible_session",
  "session_cleanup_failed",
  "invalid_session_state",
  "internal_error",
]);
export type GatewayErrorCode = z.infer<typeof GatewayErrorCodeSchema>;

export const RunEventSchema = z
  .object({
    apiVersion: z.literal(API_VERSION),
    event: z.enum([
      "run_started",
      "adapter_started",
      "session_started",
      "session_update",
      "permission_requested",
      "permission_resolved",
      "cancel_requested",
      "run_completed",
      "run_failed",
    ]),
    timestamp: z.string(),
    agent: AgentNameSchema,
    sessionRef: z.string().optional(),
    durationMs: z.number().int().nonnegative().optional(),
    updateType: z.string().optional(),
    toolKind: z.string().optional(),
    toolStatus: z.string().optional(),
    decision: z.enum(["allowed", "rejected", "cancelled"]).optional(),
    errorCode: GatewayErrorCodeSchema.optional(),
    error: z.string().optional(),
  })
  .strict();
export type RunEvent = z.infer<typeof RunEventSchema>;

export const CompletedRunResultSchema = z
  .object({
    apiVersion: z.literal(API_VERSION),
    status: z.literal("completed"),
    text: z.string(),
    sessionRef: z.string(),
    agent: AgentNameSchema,
    cwd: z.string(),
    durationMs: z.number().int().nonnegative(),
    stopReason: StopReasonSchema,
    events: z.array(RunEventSchema).optional(),
  })
  .strict();
export type CompletedRunResult = z.infer<typeof CompletedRunResultSchema>;

export const FailedRunResultSchema = z
  .object({
    apiVersion: z.literal(API_VERSION),
    status: z.literal("failed"),
    errorCode: GatewayErrorCodeSchema,
    error: z.string(),
    agent: AgentNameSchema.optional(),
    cwd: z.string().optional(),
    sessionRef: z.string().optional(),
    durationMs: z.number().int().nonnegative(),
    events: z.array(RunEventSchema).optional(),
  })
  .strict();
export type FailedRunResult = z.infer<typeof FailedRunResultSchema>;

export const RunResultSchema = z.union([
  CompletedRunResultSchema,
  FailedRunResultSchema,
]);
export type RunResult = z.infer<typeof RunResultSchema>;
