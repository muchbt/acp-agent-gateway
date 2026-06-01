import { API_VERSION, type AgentName, type RunEvent } from "./contracts.js";

export type RunEventInput = Omit<
  RunEvent,
  "apiVersion" | "timestamp" | "agent"
>;

export class EventCollector {
  readonly #agent: AgentName;
  readonly #includeEvents: boolean;
  readonly #onEvent?: (event: RunEvent) => void;
  readonly #events: RunEvent[] = [];

  constructor(
    agent: AgentName,
    includeEvents: boolean,
    onEvent?: (event: RunEvent) => void,
  ) {
    this.#agent = agent;
    this.#includeEvents = includeEvents;
    this.#onEvent = onEvent;
  }

  emit(input: RunEventInput): void {
    const event: RunEvent = {
      apiVersion: API_VERSION,
      timestamp: new Date().toISOString(),
      agent: this.#agent,
      ...input,
    };
    if (this.#includeEvents) {
      this.#events.push(event);
    }
    this.#onEvent?.(event);
  }

  includedEvents(): RunEvent[] | undefined {
    return this.#includeEvents ? [...this.#events] : undefined;
  }
}
