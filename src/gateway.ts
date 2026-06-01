import {
  API_VERSION,
  CreateSessionRequestSchema,
  PromptRequestSchema,
  RunRequestSchema,
  type CreateSessionRequestInput,
  type FailedRunResult,
  type PromptRequest,
  type PromptRequestInput,
  type RunEvent,
  type RunRequest,
  type RunRequestInput,
  type RunResult,
} from "./contracts.js";
import { GatewayError, toGatewayError } from "./errors.js";
import { EventCollector } from "./events.js";
import type { InteractiveApproval } from "./permissions.js";
import { SessionHandle, SessionManager } from "./session.js";

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

export class ManagedSession {
  readonly sessionRef: string;
  readonly agent: RunRequest["agent"];
  readonly cwd: string;
  readonly #session: SessionHandle;
  readonly #onEvent?: (event: RunEvent) => void;

  constructor(session: SessionHandle, onEvent?: (event: RunEvent) => void) {
    this.#session = session;
    this.sessionRef = session.sessionRef;
    this.agent = session.adapter.agent;
    this.cwd = session.cwd;
    this.#onEvent = onEvent;
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
    await this.#session.release();
  }

  async close(): Promise<void> {
    await this.#session.close();
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

  constructor(sessionManager = new SessionManager()) {
    this.#sessionManager = sessionManager;
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
      return new ManagedSession(session, options.onEvent);
    } catch (error) {
      throw toGatewayError(error);
    } finally {
      timeouts.dispose();
    }
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
    stopReason: promptResult.stopReason,
    ...(collector.includedEvents()
      ? { events: collector.includedEvents() }
      : {}),
  };
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
