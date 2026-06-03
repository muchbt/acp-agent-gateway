import {
  AgentStopReasonSchema,
  API_VERSION,
  CreateSessionRequestSchema,
  ForgetRequestSchema,
  PromptRequestSchema,
  ResumeSessionRequestSchema,
  RunRequestSchema,
  type CreateSessionRequestInput,
  type FailedRunResult,
  type ForgetRequestInput,
  type PromptRequest,
  type PromptRequestInput,
  type RecoveryMeta,
  type ResumeSessionRequestInput,
  type RunEvent,
  type RunRequest,
  type RunRequestInput,
  type RunResult,
  type StopReason,
} from "./contracts.js";
import { GatewayError, toGatewayError } from "./errors.js";
import { EventCollector } from "./events.js";
import type { InteractiveApproval } from "./permissions.js";
import { AgentRegistry } from "./registry.js";
import { SessionHandle, SessionManager } from "./session.js";
import {
  buildCapabilitySnapshot,
  SessionStateStore,
  type SessionLease,
  type SessionRecord,
} from "./store.js";
import type { InitializeResponse } from "@agentclientprotocol/sdk";

export interface SessionOptions {
  onEvent?: (event: RunEvent) => void;
  interactiveApproval?: InteractiveApproval;
  signal?: AbortSignal;
}

export interface PromptOptions {
  onEvent?: (event: RunEvent) => void;
  signal?: AbortSignal;
}

export type RunOptions = SessionOptions;

export interface ResumeSessionResult {
  session: ManagedSession;
  recovery: RecoveryMeta;
  requestedSessionRef?: string;
}

export class ManagedSession {
  readonly sessionRef: string;
  readonly agent: RunRequest["agent"];
  readonly cwd: string;
  readonly recovery?: RecoveryMeta;
  readonly requestedSessionRef?: string;
  readonly #session: SessionHandle;
  readonly #onEvent?: (event: RunEvent) => void;
  readonly #beforeClose?: (sessionRef: string) => Promise<void>;
  readonly #onClose?: (sessionRef: string) => Promise<void>;
  readonly #onRelease?: () => Promise<void>;
  #leaseRelease?: Promise<void>;

  constructor(
    session: SessionHandle,
    onEvent?: (event: RunEvent) => void,
    beforeClose?: (sessionRef: string) => Promise<void>,
    onClose?: (sessionRef: string) => Promise<void>,
    onRelease?: () => Promise<void>,
    recoveryMeta?: {
      recovery: RecoveryMeta;
      requestedSessionRef?: string;
    },
  ) {
    this.#session = session;
    this.sessionRef = session.sessionRef;
    this.agent = session.adapter.agent;
    this.cwd = session.cwd;
    this.#onEvent = onEvent;
    this.#beforeClose = beforeClose;
    this.#onClose = onClose;
    this.#onRelease = onRelease;
    this.recovery = recoveryMeta?.recovery;
    this.requestedSessionRef = recoveryMeta?.requestedSessionRef;
  }

  async prompt(
    input: PromptRequestInput,
    options: PromptOptions = {},
  ): Promise<RunResult> {
    const started = Date.now();
    const parsed = PromptRequestSchema.safeParse(input);
    if (!parsed.success) {
      return failed(
        new GatewayError("invalid_request", parsed.error.message),
        started,
        this.#context(),
      );
    }
    const collector = new EventCollector(
      this.agent,
      parsed.data.includeEvents,
      options.onEvent ?? this.#onEvent,
    );
    collector.emit({ event: "run_started" });
    return executePrompt(
      this.#session,
      parsed.data,
      collector,
      options.signal,
      started,
    );
  }

  async release(): Promise<void> {
    try {
      await this.#session.release();
    } catch (error) {
      await this.#releaseLease().catch(() => undefined);
      throw error;
    }
    await this.#releaseLease();
  }

  async close(): Promise<void> {
    try {
      await this.#close();
    } catch (error) {
      await this.#session.release().catch(() => undefined);
      await this.#releaseLease().catch(() => undefined);
      throw error;
    }
    await this.#releaseLease();
  }

  async #close(): Promise<void> {
    if (this.#session.supportsClose()) {
      try {
        await this.#beforeClose?.(this.sessionRef);
      } catch (error) {
        throw new GatewayError(
          "session_cleanup_failed",
          "Gateway session reference could not be marked closing before Agent-side close",
          { cause: error },
        );
      }
    }
    await this.#session.close();
    try {
      await this.#onClose?.(this.sessionRef);
    } catch (error) {
      throw new GatewayError(
        "session_cleanup_failed",
        "Agent-side session was closed but Gateway session reference cleanup failed",
        { cause: error },
      );
    }
  }

  async #releaseLease(): Promise<void> {
    try {
      this.#leaseRelease ??= this.#onRelease?.() ?? Promise.resolve();
      await this.#leaseRelease;
    } catch (error) {
      throw new GatewayError(
        "session_cleanup_failed",
        "Gateway session lease cleanup failed",
        { cause: error },
      );
    }
  }

  #context(): FailedContext {
    return {
      agent: this.agent,
      cwd: this.cwd,
      sessionRef: this.sessionRef,
    };
  }
}

export class AcpAgentGateway {
  readonly #sessionManager: SessionManager;
  readonly #store: SessionStateStore;
  readonly #registry: AgentRegistry;

  constructor(
    sessionManager?: SessionManager,
    store?: SessionStateStore,
    registry?: AgentRegistry,
  ) {
    this.#sessionManager = sessionManager ?? new SessionManager();
    this.#store = store ?? new SessionStateStore();
    this.#registry = registry ?? new AgentRegistry();
  }

  async createSession(
    input: CreateSessionRequestInput,
    options: SessionOptions = {},
  ): Promise<ManagedSession> {
    const parsed = CreateSessionRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new GatewayError("invalid_request", parsed.error.message);
    }
    const request = parsed.data;
    const collector = new EventCollector(request.agent, false, options.onEvent);
    const timeouts = new RunTimeoutController(
      request.timeoutMs,
      request.idleTimeoutMs,
      options.signal,
    );
    try {
      const session = await Promise.race([
        this.#sessionManager.open({
          agent: request.agent,
          cwd: request.cwd,
          ...(request.model ? { model: request.model } : {}),
          permissionPolicy: request.permissionPolicy,
          ...(options.interactiveApproval
            ? { interactiveApproval: options.interactiveApproval }
            : {}),
          collector,
          onActivity: () => timeouts.touch(),
          signal: timeouts.signal,
        }),
        timeouts.failurePromise,
      ]);

      let lease: SessionLease | undefined;
      const releaseLease = async () => {
        if (!lease) {
          return;
        }
        const ownedLease = lease;
        await this.#store.releaseLease(ownedLease);
        lease = undefined;
      };

      if (request.durable) {
        const adapter = session.adapter;
        const initResp = session.initializeResponse;
        try {
          lease = await this.#store.acquireLease(session.sessionRef);
          await this.#store.save({
            schemaVersion: 1,
            sessionRef: session.sessionRef,
            acpSessionId: session.acpSessionId,
            agent: adapter.agent,
            cwd: session.cwd,
            permissionPolicy: request.permissionPolicy,
            ...(request.model ? { model: request.model } : {}),
            adapterFingerprint: adapter.fingerprint,
            capabilitySnapshot: buildCapabilitySnapshot({
              loadSession: Boolean(initResp.agentCapabilities?.loadSession),
              closeAdvertised: Boolean(
                initResp.agentCapabilities?.sessionCapabilities?.close,
              ),
              listSessions: Boolean(
                initResp.agentCapabilities?.sessionCapabilities?.list,
              ),
              resumeSession: Boolean(
                initResp.agentCapabilities?.sessionCapabilities?.resume,
              ),
            }),
            lifecycle: "active",
            createdAt: new Date().toISOString(),
            lastUsedAt: new Date().toISOString(),
          });
        } catch (saveError) {
          await releaseLease().catch(() => undefined);
          await session.release();
          throw saveError;
        }
      }

      const beforeClose = request.durable
        ? async (ref: string) => {
            await this.#markClosing(ref);
          }
        : undefined;
      const onClose = request.durable
        ? async (ref: string) => {
            await this.#store.remove(ref);
          }
        : undefined;

      return new ManagedSession(
        session,
        options.onEvent,
        beforeClose,
        onClose,
        request.durable ? releaseLease : undefined,
      );
    } catch (error) {
      throw toGatewayError(error);
    } finally {
      timeouts.dispose();
    }
  }

  async resumeSession(
    input: ResumeSessionRequestInput,
    options: SessionOptions = {},
  ): Promise<ResumeSessionResult> {
    const parsed = ResumeSessionRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new GatewayError("invalid_request", parsed.error.message);
    }
    const request = parsed.data;

    let record: SessionRecord | undefined;
    let lease: SessionLease | undefined;
    let session: SessionHandle | undefined;
    let timeouts: RunTimeoutController | undefined;
    const releaseLease = async () => {
      if (!lease) {
        return;
      }
      const ownedLease = lease;
      await this.#store.releaseLease(ownedLease);
      lease = undefined;
    };
    try {
      lease = await this.#store.acquireLease(request.sessionRef);
      record = await this.#store.load(request.sessionRef);
      if (!record) {
        throw new GatewayError(
          "invalid_request",
          `Session reference not found: ${request.sessionRef}`,
        );
      }
      if (record.lifecycle === "closing") {
        throw new GatewayError(
          "invalid_session_state",
          `Session reference is closing and cannot be recovered: ${request.sessionRef}`,
        );
      }

      const adapter = await this.#registry.resolve(record.agent);
      if (adapter.fingerprint !== record.adapterFingerprint) {
        throw new GatewayError(
          "incompatible_session",
          "Adapter configuration has changed and is no longer compatible with the persisted session",
        );
      }

      const collector = new EventCollector(
        record.agent,
        false,
        options.onEvent,
      );
      const recoveryTimeouts = new RunTimeoutController(
        900_000,
        undefined,
        options.signal,
      );
      timeouts = recoveryTimeouts;
      let initResponse: InitializeResponse;
      try {
        initResponse = await Promise.race([
          this.#sessionManager.probe(
            record.agent,
            record.permissionPolicy,
            record.cwd,
            recoveryTimeouts.signal,
          ),
          recoveryTimeouts.failurePromise,
        ]);
      } catch (error) {
        throw toGatewayError(error);
      }

      const currentCanResume = Boolean(
        initResponse.agentCapabilities?.sessionCapabilities?.resume,
      );
      const currentCanLoad = Boolean(
        initResponse.agentCapabilities?.loadSession,
      );

      const canResume =
        record.capabilitySnapshot.resumeSession && currentCanResume;
      const canLoad = record.capabilitySnapshot.loadSession && currentCanLoad;

      if (!canResume && !canLoad) {
        throw new GatewayError(
          "unsupported_session_recovery",
          "Agent does not support session/resume or session/load",
        );
      }

      const operation: "resume" | "load" = canResume ? "resume" : "load";
      session = await Promise.race([
        this.#sessionManager.open({
          agent: record.agent,
          cwd: record.cwd,
          ...(record.model ? { model: record.model } : {}),
          permissionPolicy: record.permissionPolicy,
          ...(options.interactiveApproval
            ? { interactiveApproval: options.interactiveApproval }
            : {}),
          collector,
          onActivity: () => recoveryTimeouts.touch(),
          signal: recoveryTimeouts.signal,
          operation,
          acpSessionId: record.acpSessionId,
          sessionRef: record.sessionRef,
        }),
        recoveryTimeouts.failurePromise,
      ]);

      try {
        await this.#store.save({
          ...record,
          lastUsedAt: new Date().toISOString(),
        });
      } catch (saveError) {
        await session.release();
        throw saveError;
      }

      const onClose = async (ref: string) => {
        await this.#store.remove(ref);
      };
      const beforeClose = async (ref: string) => {
        await this.#markClosing(ref);
      };

      const managed = new ManagedSession(
        session,
        options.onEvent,
        beforeClose,
        onClose,
        releaseLease,
        {
          recovery: "resumed",
        },
      );

      return { session: managed, recovery: "resumed" };
    } catch (error) {
      const gatewayError = toGatewayError(error);
      try {
        await releaseLease();
      } catch (releaseError) {
        throw new GatewayError(
          "session_cleanup_failed",
          "Gateway session lease cleanup failed",
          { cause: releaseError },
        );
      }

      if (
        session === undefined &&
        record !== undefined &&
        request.fallback === "new-session" &&
        isRecoveryError(gatewayError)
      ) {
        let fallbackSession: SessionHandle | undefined;
        let fallbackLease: SessionLease | undefined;
        const releaseFallbackLease = async () => {
          if (!fallbackLease) {
            return;
          }
          const ownedLease = fallbackLease;
          await this.#store.releaseLease(ownedLease);
          fallbackLease = undefined;
        };
        try {
          const fallbackTimeouts =
            timeouts ??
            new RunTimeoutController(900_000, undefined, options.signal);
          timeouts = fallbackTimeouts;
          const collector = new EventCollector(
            record.agent,
            false,
            options.onEvent,
          );
          fallbackSession = await Promise.race([
            this.#sessionManager.open({
              agent: record.agent,
              cwd: record.cwd,
              ...(record.model ? { model: record.model } : {}),
              permissionPolicy: record.permissionPolicy,
              ...(options.interactiveApproval
                ? { interactiveApproval: options.interactiveApproval }
                : {}),
              collector,
              onActivity: () => fallbackTimeouts.touch(),
              signal: fallbackTimeouts.signal,
            }),
            fallbackTimeouts.failurePromise,
          ]);

          fallbackLease = await this.#store.acquireLease(
            fallbackSession.sessionRef,
          );
          const fallbackOnClose = async (ref: string) => {
            await this.#store.remove(ref);
          };

          await this.#store.save({
            schemaVersion: 1,
            sessionRef: fallbackSession.sessionRef,
            acpSessionId: fallbackSession.acpSessionId,
            agent: fallbackSession.adapter.agent,
            cwd: fallbackSession.cwd,
            permissionPolicy: record.permissionPolicy,
            ...(record.model ? { model: record.model } : {}),
            adapterFingerprint: fallbackSession.adapter.fingerprint,
            capabilitySnapshot: buildCapabilitySnapshot({
              loadSession: Boolean(
                fallbackSession.initializeResponse.agentCapabilities
                  ?.loadSession,
              ),
              closeAdvertised: Boolean(
                fallbackSession.initializeResponse.agentCapabilities
                  ?.sessionCapabilities?.close,
              ),
              listSessions: Boolean(
                fallbackSession.initializeResponse.agentCapabilities
                  ?.sessionCapabilities?.list,
              ),
              resumeSession: Boolean(
                fallbackSession.initializeResponse.agentCapabilities
                  ?.sessionCapabilities?.resume,
              ),
            }),
            lifecycle: "active",
            createdAt: new Date().toISOString(),
            lastUsedAt: new Date().toISOString(),
          });

          const managed = new ManagedSession(
            fallbackSession,
            options.onEvent,
            async (ref: string) => {
              await this.#markClosing(ref);
            },
            fallbackOnClose,
            releaseFallbackLease,
            {
              recovery: "fallback-new-session",
              requestedSessionRef: request.sessionRef,
            },
          );

          return {
            session: managed,
            recovery: "fallback-new-session",
            requestedSessionRef: request.sessionRef,
          };
        } catch (fallbackError) {
          await fallbackSession?.release().catch(() => undefined);
          await releaseFallbackLease().catch(() => undefined);
          throw toGatewayError(fallbackError);
        }
      }

      throw gatewayError;
    } finally {
      timeouts?.dispose();
    }
  }

  async forget(
    input: ForgetRequestInput,
  ): Promise<{ apiVersion: string; sessionRef: string }> {
    const parsed = ForgetRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new GatewayError("invalid_request", parsed.error.message);
    }
    const lease = await this.#store.acquireLease(parsed.data.sessionRef);
    try {
      await this.#store.remove(parsed.data.sessionRef);
    } finally {
      await this.#store.releaseLease(lease);
    }
    return { apiVersion: API_VERSION, sessionRef: parsed.data.sessionRef };
  }

  async #markClosing(sessionRef: string): Promise<void> {
    const record = await this.#store.load(sessionRef);
    if (!record) {
      throw new Error(`Session reference not found: ${sessionRef}`);
    }
    await this.#store.save({
      ...record,
      lifecycle: "closing",
      lastUsedAt: new Date().toISOString(),
    });
  }

  async run(
    input: RunRequestInput,
    options: RunOptions = {},
  ): Promise<RunResult> {
    const started = Date.now();
    const parsed = RunRequestSchema.safeParse(input);
    if (!parsed.success) {
      return failed(
        new GatewayError("invalid_request", parsed.error.message),
        started,
      );
    }
    const request = parsed.data;
    const collector = new EventCollector(
      request.agent,
      request.includeEvents,
      options.onEvent,
    );
    collector.emit({ event: "run_started" });

    let session: SessionHandle | undefined;
    let execution: Promise<{ text: string; stopReason: string }> | undefined;
    const timeouts = new RunTimeoutController(
      request.timeoutMs,
      request.idleTimeoutMs,
      options.signal,
    );
    try {
      const openAndPrompt = async () => {
        session = await this.#sessionManager.open({
          agent: request.agent,
          cwd: request.cwd,
          ...(request.model ? { model: request.model } : {}),
          permissionPolicy: request.permissionPolicy,
          ...(options.interactiveApproval
            ? { interactiveApproval: options.interactiveApproval }
            : {}),
          collector,
          onActivity: () => timeouts.touch(),
          signal: timeouts.signal,
        });
        return session.prompt(request.prompt, {
          collector,
          onActivity: () => timeouts.touch(),
        });
      };
      execution = openAndPrompt();
      const promptResult = await Promise.race([
        execution,
        timeouts.failurePromise,
      ]);
      if (!session) {
        throw new GatewayError(
          "internal_error",
          "Session was not created before prompt completion",
        );
      }
      return completed(session, promptResult, collector, started);
    } catch (error) {
      const gatewayError = toGatewayError(error);
      if (session && isCancellationError(gatewayError)) {
        await cancelWithGrace(
          session,
          execution,
          request.gracePeriodMs,
          collector,
        );
      }
      collector.emit({
        event: "run_failed",
        ...(session ? { sessionRef: session.sessionRef } : {}),
        durationMs: Date.now() - started,
        errorCode: gatewayError.code,
        error: gatewayError.message,
      });
      return failed(gatewayError, started, {
        agent: request.agent,
        cwd: session?.cwd ?? request.cwd,
        sessionRef: session?.sessionRef,
        events: collector.includedEvents(),
      });
    } finally {
      timeouts.dispose();
      await session?.release();
    }
  }
}

export async function createSession(
  request: CreateSessionRequestInput,
  options?: SessionOptions,
): Promise<ManagedSession> {
  return new AcpAgentGateway().createSession(request, options);
}

export async function resumeSession(
  request: ResumeSessionRequestInput,
  options?: SessionOptions,
): Promise<ResumeSessionResult> {
  return new AcpAgentGateway().resumeSession(request, options);
}

export async function forget(
  request: ForgetRequestInput,
): Promise<{ apiVersion: string; sessionRef: string }> {
  return new AcpAgentGateway().forget(request);
}

export async function run(
  request: RunRequestInput,
  options?: RunOptions,
): Promise<RunResult> {
  return new AcpAgentGateway().run(request, options);
}

async function executePrompt(
  session: SessionHandle,
  request: PromptRequest,
  collector: EventCollector,
  signal: AbortSignal | undefined,
  started: number,
): Promise<RunResult> {
  let execution: Promise<{ text: string; stopReason: string }> | undefined;
  const timeouts = new RunTimeoutController(
    request.timeoutMs,
    request.idleTimeoutMs,
    signal,
  );
  try {
    execution = session.prompt(request.prompt, {
      collector,
      onActivity: () => timeouts.touch(),
    });
    const promptResult = await Promise.race([
      execution,
      timeouts.failurePromise,
    ]);
    return completed(session, promptResult, collector, started);
  } catch (error) {
    const gatewayError = toGatewayError(error);
    if (isCancellationError(gatewayError)) {
      await cancelWithGrace(
        session,
        execution,
        request.gracePeriodMs,
        collector,
      );
    }
    collector.emit({
      event: "run_failed",
      sessionRef: session.sessionRef,
      durationMs: Date.now() - started,
      errorCode: gatewayError.code,
      error: gatewayError.message,
    });
    return failed(gatewayError, started, {
      agent: session.adapter.agent,
      cwd: session.cwd,
      sessionRef: session.sessionRef,
      events: collector.includedEvents(),
    });
  } finally {
    timeouts.dispose();
  }
}

function completed(
  session: SessionHandle,
  promptResult: { text: string; stopReason: string },
  collector: EventCollector,
  started: number,
): RunResult {
  if (promptResult.stopReason === "cancelled") {
    throw new GatewayError("cancelled", "Agent run was cancelled");
  }
  const stopReason = normalizeStopReason(promptResult);
  const durationMs = Date.now() - started;
  collector.emit({
    event: "run_completed",
    sessionRef: session.sessionRef,
    durationMs,
  });
  return {
    apiVersion: API_VERSION,
    status: "completed",
    text: promptResult.text,
    sessionRef: session.sessionRef,
    agent: session.adapter.agent,
    cwd: session.cwd,
    durationMs,
    stopReason,
    ...(collector.includedEvents()
      ? { events: collector.includedEvents() }
      : {}),
  };
}

function normalizeStopReason(promptResult: {
  text: string;
  stopReason: string;
}): StopReason {
  const parsed = AgentStopReasonSchema.safeParse(promptResult.stopReason);
  if (!parsed.success) {
    throw new GatewayError(
      "protocol_error",
      `Unsupported Agent stop reason: ${promptResult.stopReason}`,
    );
  }
  if (parsed.data === "end_turn" && promptResult.text === "") {
    return "empty_response";
  }
  return parsed.data;
}

class RunTimeoutController {
  readonly failurePromise: Promise<never>;
  readonly #timeoutMs: number;
  readonly #idleTimeoutMs?: number;
  readonly #abortSignal?: AbortSignal;
  readonly #abortController = new AbortController();
  readonly #onAbort: () => void;
  #reject!: (error: GatewayError) => void;
  #timeout?: NodeJS.Timeout;
  #idleTimeout?: NodeJS.Timeout;
  #failed = false;

  constructor(
    timeoutMs: number,
    idleTimeoutMs?: number,
    abortSignal?: AbortSignal,
  ) {
    this.#timeoutMs = timeoutMs;
    this.#idleTimeoutMs = idleTimeoutMs;
    this.#abortSignal = abortSignal;
    this.#onAbort = () =>
      this.#fail(new GatewayError("cancelled", "Agent run was cancelled"));
    this.failurePromise = new Promise((_, reject) => {
      this.#reject = reject;
    });
    this.#timeout = setTimeout(
      () => this.#fail(new GatewayError("timeout", "Agent run timed out")),
      this.#timeoutMs,
    );
    this.touch();
    if (abortSignal?.aborted) {
      this.#onAbort();
    } else {
      abortSignal?.addEventListener("abort", this.#onAbort, { once: true });
    }
  }

  get signal(): AbortSignal {
    return this.#abortController.signal;
  }

  touch(): void {
    if (this.#failed || this.#idleTimeoutMs === undefined) {
      return;
    }
    clearTimeout(this.#idleTimeout);
    this.#idleTimeout = setTimeout(
      () =>
        this.#fail(
          new GatewayError("idle_timeout", "Agent run idle timeout exceeded"),
        ),
      this.#idleTimeoutMs,
    );
  }

  dispose(): void {
    clearTimeout(this.#timeout);
    clearTimeout(this.#idleTimeout);
    this.#abortSignal?.removeEventListener("abort", this.#onAbort);
  }

  #fail(error: GatewayError): void {
    if (this.#failed) {
      return;
    }
    this.#failed = true;
    this.#abortController.abort();
    this.#reject(error);
  }
}

async function cancelWithGrace(
  session: SessionHandle,
  execution: Promise<unknown> | undefined,
  gracePeriodMs: number,
  collector: EventCollector,
): Promise<void> {
  try {
    await session.cancel(collector);
  } catch {
    await session.release();
    return;
  }
  if (!execution) {
    return;
  }
  const settled = await Promise.race([
    execution.then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolve) =>
      setTimeout(() => resolve(false), gracePeriodMs),
    ),
  ]);
  if (!settled) {
    await session.release();
  }
}

function isCancellationError(error: GatewayError): boolean {
  return (
    error.code === "timeout" ||
    error.code === "idle_timeout" ||
    error.code === "cancelled"
  );
}

function isRecoveryError(error: GatewayError): boolean {
  return (
    error.code === "incompatible_session" ||
    error.code === "unsupported_session_recovery" ||
    error.code === "protocol_error" ||
    error.code === "adapter_spawn_failed" ||
    error.code === "adapter_not_found"
  );
}

interface FailedContext {
  agent?: RunRequest["agent"];
  cwd?: string;
  sessionRef?: string;
  events?: RunEvent[];
}

function failed(
  error: GatewayError,
  started: number,
  context: FailedContext = {},
): FailedRunResult {
  return {
    apiVersion: API_VERSION,
    status: "failed",
    errorCode: error.code,
    error: error.message,
    durationMs: Date.now() - started,
    ...(context.agent ? { agent: context.agent } : {}),
    ...(context.cwd ? { cwd: context.cwd } : {}),
    ...(context.sessionRef ? { sessionRef: context.sessionRef } : {}),
    ...(context.events ? { events: context.events } : {}),
  };
}
