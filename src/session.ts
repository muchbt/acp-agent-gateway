import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  type Client,
  type InitializeResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionConfigSelectGroup,
  type SessionConfigSelectOption,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import type { PermissionPolicy } from "./contracts.js";
import { GatewayError } from "./errors.js";
import type { EventCollector } from "./events.js";
import { decidePermission, type InteractiveApproval } from "./permissions.js";
import { AgentRegistry, type ResolvedAdapter } from "./registry.js";
import {
  spawnAdapterTransport,
  type AdapterTransport,
  type TransportFactory,
} from "./transport.js";

export interface OpenSessionRequest {
  agent: string;
  cwd: string;
  model?: string;
  permissionPolicy: PermissionPolicy;
  interactiveApproval?: InteractiveApproval;
  signal?: AbortSignal;
  collector: EventCollector;
  onActivity(): void;
  operation?: "new" | "resume" | "load";
  acpSessionId?: string;
  sessionRef?: string;
}

interface SessionHooks {
  collector: EventCollector;
  onActivity(): void;
}

export class SessionHandle {
  readonly sessionRef: string;
  readonly acpSessionId: string;
  readonly cwd: string;
  readonly adapter: ResolvedAdapter;
  readonly initializeResponse: InitializeResponse;
  readonly #connection: ClientSideConnection;
  readonly #transport: AdapterTransport;
  readonly #permissionPolicy: PermissionPolicy;
  readonly #interactiveApproval?: InteractiveApproval;
  readonly #lifecycleHooks: SessionHooks;
  #activeTurnHooks?: SessionHooks;
  #state: "ready" | "prompting" | "released" | "closed" = "ready";
  #lastNotificationAt = Date.now();
  #text = "";

  constructor(params: {
    sessionRef: string;
    acpSessionId: string;
    cwd: string;
    adapter: ResolvedAdapter;
    initializeResponse: InitializeResponse;
    connection: ClientSideConnection;
    transport: AdapterTransport;
    permissionPolicy: PermissionPolicy;
    interactiveApproval?: InteractiveApproval;
    lifecycleHooks: SessionHooks;
  }) {
    this.sessionRef = params.sessionRef;
    this.acpSessionId = params.acpSessionId;
    this.cwd = params.cwd;
    this.adapter = params.adapter;
    this.initializeResponse = params.initializeResponse;
    this.#connection = params.connection;
    this.#transport = params.transport;
    this.#permissionPolicy = params.permissionPolicy;
    this.#interactiveApproval = params.interactiveApproval;
    this.#lifecycleHooks = params.lifecycleHooks;
  }

  receiveNotification(params: SessionNotification): void {
    const hooks = this.#hooks();
    hooks.onActivity();
    emitSessionUpdate(hooks.collector, this.sessionRef, params);
    this.#lastNotificationAt = Date.now();
    const text = agentMessageText(params);
    if (text) {
      this.#text += text;
    }
  }

  async requestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const hooks = this.#hooks();
    hooks.onActivity();
    const toolKind = params.toolCall.kind ?? "other";
    hooks.collector.emit({
      event: "permission_requested",
      sessionRef: this.sessionRef,
      toolKind,
    });
    const decision = await decidePermission(
      params,
      this.#permissionPolicy,
      this.#interactiveApproval,
    );
    hooks.collector.emit({
      event: "permission_resolved",
      sessionRef: this.sessionRef,
      toolKind,
      decision: decision.decision,
    });
    hooks.onActivity();
    return decision.response;
  }

  async prompt(
    prompt: string,
    hooks: SessionHooks,
  ): Promise<{ text: string; stopReason: string }> {
    this.#assertReady("prompt");
    this.#state = "prompting";
    this.#activeTurnHooks = hooks;
    this.#text = "";
    hooks.onActivity();
    try {
      const response = await this.#connection.prompt({
        sessionId: this.acpSessionId,
        prompt: [{ type: "text", text: prompt }],
      });
      hooks.onActivity();
      await this.#drainLateNotifications();
      return { text: this.#text, stopReason: response.stopReason };
    } finally {
      this.#activeTurnHooks = undefined;
      if (this.#state === "prompting") {
        this.#state = "ready";
      }
    }
  }

  async cancel(collector = this.#hooks().collector): Promise<void> {
    collector.emit({
      event: "cancel_requested",
      sessionRef: this.sessionRef,
    });
    await this.#connection.cancel({ sessionId: this.acpSessionId });
  }

  async release(): Promise<void> {
    if (this.#state === "released" || this.#state === "closed") {
      return;
    }
    this.#state = "released";
    await this.#transport.terminate();
  }

  supportsClose(): boolean {
    return Boolean(
      this.initializeResponse.agentCapabilities?.sessionCapabilities?.close,
    );
  }

  async close(): Promise<void> {
    this.#assertReady("close");
    if (!this.supportsClose()) {
      await this.release();
      throw new GatewayError(
        "unsupported_session_close",
        "Agent does not advertise session/close support",
      );
    }
    this.#state = "closed";
    try {
      await this.#connection.closeSession({ sessionId: this.acpSessionId });
    } finally {
      await this.#transport.terminate();
    }
  }

  #assertReady(operation: string): void {
    if (this.#state !== "ready") {
      throw new GatewayError(
        "invalid_session_state",
        `Cannot ${operation} session while it is ${this.#state}`,
      );
    }
  }

  #hooks(): SessionHooks {
    return this.#activeTurnHooks ?? this.#lifecycleHooks;
  }

  async #drainLateNotifications(): Promise<void> {
    const started = Date.now();
    this.#lastNotificationAt = started;
    while (
      Date.now() - this.#lastNotificationAt < POST_PROMPT_QUIET_PERIOD_MS &&
      Date.now() - started < POST_PROMPT_MAX_DRAIN_MS
    ) {
      await delay(POST_PROMPT_POLL_INTERVAL_MS);
    }
  }
}

const POST_PROMPT_QUIET_PERIOD_MS = 500;
const POST_PROMPT_MAX_DRAIN_MS = 2_000;
const POST_PROMPT_POLL_INTERVAL_MS = 25;

export class SessionManager {
  readonly #registry: AgentRegistry;
  readonly #transportFactory: TransportFactory;

  constructor(
    registry = new AgentRegistry(),
    transportFactory = spawnAdapterTransport,
  ) {
    this.#registry = registry;
    this.#transportFactory = transportFactory;
  }

  async probe(
    agent: string,
    permissionPolicy: PermissionPolicy,
    cwd?: string,
    signal?: AbortSignal,
  ): Promise<InitializeResponse> {
    if (signal?.aborted) {
      throw new GatewayError("cancelled", "Agent run was cancelled");
    }
    const adapter = await this.#registry.resolve(agent);
    const cwdNormalized = await normalizeWorkspace(cwd ?? process.cwd());
    const transport = await this.#transportFactory(
      adapter,
      cwdNormalized,
      permissionPolicy,
    );
    let termination: Promise<void> | undefined;
    const terminate = () => (termination ??= transport.terminate());
    const onAbort = () => {
      void terminate().catch(() => undefined);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (signal?.aborted) {
        await terminate();
        throw new GatewayError("cancelled", "Agent run was cancelled");
      }
      const connection = new ClientSideConnection(
        () => ({
          requestPermission: async () => ({
            outcome: { outcome: "cancelled" },
          }),
          sessionUpdate: async () => undefined,
        }),
        transport.stream,
      );
      return await connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "@local/acp-agent-gateway", version: "0.1.0" },
      });
    } finally {
      signal?.removeEventListener("abort", onAbort);
      await terminate();
    }
  }

  async open(request: OpenSessionRequest): Promise<SessionHandle> {
    const cwd = await normalizeWorkspace(request.cwd);
    const adapter = await this.#registry.resolve(request.agent);
    const transport = await this.#transportFactory(
      adapter,
      cwd,
      request.permissionPolicy,
    );
    const terminateOnAbort = () => {
      void transport.terminate();
    };
    if (request.signal?.aborted) {
      await transport.terminate();
      throw new GatewayError("cancelled", "Agent run was cancelled");
    }
    request.signal?.addEventListener("abort", terminateOnAbort, { once: true });
    request.collector.emit({ event: "adapter_started" });
    const sessionRef = request.sessionRef ?? randomUUID();
    let sessionHandle: SessionHandle | undefined;
    let suppressReplay = request.operation === "load";

    const client: Client = {
      requestPermission: async (params) =>
        sessionHandle
          ? sessionHandle.requestPermission(params)
          : this.#requestPermission(request, sessionRef, params),
      sessionUpdate: async (params) => {
        request.onActivity();
        if (suppressReplay) {
          return;
        }
        if (sessionHandle) {
          sessionHandle.receiveNotification(params);
        } else {
          emitSessionUpdate(request.collector, sessionRef, params);
        }
      },
    };
    const connection = new ClientSideConnection(() => client, transport.stream);

    try {
      request.onActivity();
      const initializeResponse = await connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "@local/acp-agent-gateway", version: "0.1.0" },
      });
      request.onActivity();
      if (initializeResponse.protocolVersion !== PROTOCOL_VERSION) {
        throw new GatewayError(
          "protocol_error",
          `Unsupported ACP protocol version: ${initializeResponse.protocolVersion}`,
        );
      }

      let sessionId: string;
      let configOptions: SessionConfigOption[] | null | undefined;

      if (request.operation === "resume" && request.acpSessionId) {
        await connection.resumeSession({
          sessionId: request.acpSessionId,
          cwd,
          mcpServers: [],
        });
        sessionId = request.acpSessionId;
        request.onActivity();
      } else if (request.operation === "load" && request.acpSessionId) {
        suppressReplay = true;
        const session = await connection.loadSession({
          sessionId: request.acpSessionId,
          cwd,
          mcpServers: [],
        });
        suppressReplay = false;
        sessionId = request.acpSessionId;
        configOptions = session.configOptions;
        request.onActivity();
      } else if (request.operation) {
        throw new GatewayError(
          "invalid_request",
          `Cannot ${request.operation} without a valid ACP session ID`,
        );
      } else {
        const session = await connection.newSession({ cwd, mcpServers: [] });
        sessionId = session.sessionId;
        configOptions = session.configOptions;
        request.onActivity();
        if (request.model) {
          await configureModel(
            connection,
            sessionId,
            configOptions ?? [],
            request.model,
          );
          request.onActivity();
        }
      }

      sessionHandle = new SessionHandle({
        sessionRef,
        acpSessionId: sessionId,
        cwd,
        adapter,
        initializeResponse,
        connection,
        transport,
        permissionPolicy: request.permissionPolicy,
        ...(request.interactiveApproval
          ? { interactiveApproval: request.interactiveApproval }
          : {}),
        lifecycleHooks: {
          collector: request.collector,
          onActivity: request.onActivity,
        },
      });
      request.signal?.removeEventListener("abort", terminateOnAbort);
      request.collector.emit({ event: "session_started", sessionRef });
      return sessionHandle;
    } catch (error) {
      request.signal?.removeEventListener("abort", terminateOnAbort);
      await transport.terminate();
      throw error;
    }
  }

  async #requestPermission(
    request: OpenSessionRequest,
    sessionRef: string,
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    request.onActivity();
    const toolKind = params.toolCall.kind ?? "other";
    request.collector.emit({
      event: "permission_requested",
      sessionRef,
      toolKind,
    });
    const decision = await decidePermission(
      params,
      request.permissionPolicy,
      request.interactiveApproval,
    );
    request.collector.emit({
      event: "permission_resolved",
      sessionRef,
      toolKind,
      decision: decision.decision,
    });
    request.onActivity();
    return decision.response;
  }
}

async function normalizeWorkspace(cwd: string): Promise<string> {
  if (!isAbsolute(cwd)) {
    throw new GatewayError("invalid_request", "cwd must be an absolute path");
  }
  try {
    return await realpath(cwd);
  } catch (error) {
    throw new GatewayError("invalid_request", "cwd does not exist", {
      cause: error,
    });
  }
}

function agentMessageText(params: SessionNotification): string {
  const update = params.update;
  if (
    update.sessionUpdate === "agent_message_chunk" &&
    update.content.type === "text"
  ) {
    return update.content.text;
  }
  return "";
}

function emitSessionUpdate(
  collector: EventCollector,
  sessionRef: string,
  params: SessionNotification,
): void {
  const update = params.update;
  collector.emit({
    event: "session_update",
    sessionRef,
    updateType: update.sessionUpdate,
    ...("kind" in update && update.kind ? { toolKind: update.kind } : {}),
    ...("status" in update && update.status
      ? { toolStatus: update.status }
      : {}),
  });
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

async function configureModel(
  connection: ClientSideConnection,
  sessionId: string,
  options: SessionConfigOption[],
  model: string,
): Promise<void> {
  const modelOption = options.find(
    (option) =>
      option.type === "select" &&
      (option.category === "model" || option.id === "model"),
  );
  if (!modelOption || modelOption.type !== "select") {
    throw new GatewayError(
      "unsupported_model",
      "Agent does not expose a model selector",
    );
  }
  if (
    !selectOptions(modelOption.options).some((option) => option.value === model)
  ) {
    throw new GatewayError("unsupported_model", `Unsupported model: ${model}`);
  }
  await connection.setSessionConfigOption({
    sessionId,
    configId: modelOption.id,
    value: model,
  });
}

function selectOptions(
  options: Array<SessionConfigSelectOption> | Array<SessionConfigSelectGroup>,
): SessionConfigSelectOption[] {
  return options.flatMap((option) =>
    "group" in option ? option.options : option,
  );
}
