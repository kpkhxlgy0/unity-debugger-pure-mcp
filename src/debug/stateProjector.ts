export type DebugPhase =
  | "starting"
  | "running"
  | "stopped"
  | "reloading"
  | "terminated";

export interface DebugSessionState {
  readonly phase: DebugPhase;
  readonly stopGeneration: number;
  readonly eventSequence: number;
  readonly reason?: string;
  readonly threadId?: number;
}

export interface EventSequenceCursor {
  readonly current: number;
  next(): number;
}

export class EventSequencer implements EventSequenceCursor {
  #current = 0;

  public get current(): number {
    return this.#current;
  }

  public next(): number {
    this.#current += 1;
    return this.#current;
  }
}

export type NormalizedStateEventKind =
  | "stopped"
  | "continued"
  | "reload-started"
  | "reload-completed"
  | "terminated";

/**
 * A normalized state event whose sequence has already been allocated.
 * Event consumers must append this sequence as-is instead of calling next().
 */
export interface ProjectedStateEvent {
  readonly sequence: number;
  readonly kind: NormalizedStateEventKind;
  readonly state: DebugSessionState;
}

const RELOAD_DETECTED_PREFIX = "Domain Reload detected; waiting for assemblies.";
const RELOAD_COMPLETE_PREFIX = "Domain Reload complete;";

export class StateProjector {
  readonly #sequencer: EventSequenceCursor;
  #state: DebugSessionState;

  public constructor(sequencer: EventSequenceCursor = new EventSequencer()) {
    this.#sequencer = sequencer;
    this.#state = frozenState("starting", 0, sequencer.current);
  }

  public snapshot(): DebugSessionState {
    if (this.#state.eventSequence !== this.#sequencer.current) {
      this.#state = frozenState(
        this.#state.phase,
        this.#state.stopGeneration,
        this.#sequencer.current,
        this.#state.reason,
        this.#state.threadId,
      );
    }
    return this.#state;
  }

  public acceptAdapterMessage(message: unknown): ProjectedStateEvent | undefined {
    if (this.#state.phase === "terminated") {
      return undefined;
    }
    try {
      return this.#acceptAdapterMessage(message);
    } catch {
      return undefined;
    }
  }

  #acceptAdapterMessage(message: unknown): ProjectedStateEvent | undefined {
    if (!isRecord(message)) {
      return undefined;
    }

    const type = message.type;
    if (
      type === "response" &&
      this.#state.phase === "starting" &&
      message.command === "attach" &&
      message.success === true
    ) {
      this.#state = frozenState(
        "running",
        this.#state.stopGeneration,
        this.#sequencer.current,
      );
      return undefined;
    }

    const event = message.event;
    if (type !== "event" || typeof event !== "string") {
      return undefined;
    }
    const body = message.body;

    switch (event) {
      case "stopped":
        return this.#acceptStopped(body);
      case "continued":
        if (this.#state.phase === "stopped" && validOptionalBody(body)) {
          return this.#transition(
            "continued",
            "running",
            this.#state.stopGeneration + 1,
          );
        }
        return undefined;
      case "terminated":
        if (validOptionalBody(body)) {
          const invalidatesLiveGeneration =
            this.#state.phase === "stopped" || this.#state.phase === "reloading";
          return this.#transition(
            "terminated",
            "terminated",
            this.#state.stopGeneration + (invalidatesLiveGeneration ? 1 : 0),
          );
        }
        return undefined;
      case "output":
        return this.#acceptOutput(body);
      default:
        return undefined;
    }
  }

  #acceptStopped(body: unknown): ProjectedStateEvent | undefined {
    if (
      (this.#state.phase !== "starting" &&
        this.#state.phase !== "running" &&
        this.#state.phase !== "stopped") ||
      !isRecord(body)
    ) {
      return undefined;
    }
    const reason = body.reason;
    const threadId = body.threadId;
    if (!isNonEmptyString(reason)) {
      return undefined;
    }
    if (threadId !== undefined && !Number.isSafeInteger(threadId)) {
      return undefined;
    }

    return this.#transition(
      "stopped",
      "stopped",
      this.#state.stopGeneration + 1,
      reason,
      threadId as number | undefined,
    );
  }

  #acceptOutput(body: unknown): ProjectedStateEvent | undefined {
    if (
      (this.#state.phase !== "running" && this.#state.phase !== "reloading") ||
      !isRecord(body)
    ) {
      return undefined;
    }
    const category = body.category;
    const output = body.output;
    if (category !== "console" || typeof output !== "string") {
      return undefined;
    }
    if (
      this.#state.phase === "running" &&
      output.startsWith(RELOAD_DETECTED_PREFIX)
    ) {
      return this.#transition(
        "reload-started",
        "reloading",
        this.#state.stopGeneration,
      );
    }
    if (
      this.#state.phase === "reloading" &&
      output.startsWith(RELOAD_COMPLETE_PREFIX)
    ) {
      return this.#transition(
        "reload-completed",
        "running",
        this.#state.stopGeneration + 1,
      );
    }
    return undefined;
  }

  #transition(
    kind: NormalizedStateEventKind,
    phase: DebugPhase,
    stopGeneration: number,
    reason?: string,
    threadId?: number,
  ): ProjectedStateEvent {
    const sequence = this.#sequencer.next();
    this.#state = frozenState(
      phase,
      stopGeneration,
      sequence,
      reason,
      threadId,
    );
    return Object.freeze({ sequence, kind, state: this.#state });
  }
}

function frozenState(
  phase: DebugPhase,
  stopGeneration: number,
  eventSequence: number,
  reason?: string,
  threadId?: number,
): DebugSessionState {
  const state: {
    phase: DebugPhase;
    stopGeneration: number;
    eventSequence: number;
    reason?: string;
    threadId?: number;
  } = { phase, stopGeneration, eventSequence };
  if (reason !== undefined) {
    state.reason = reason;
  }
  if (threadId !== undefined) {
    state.threadId = threadId;
  }
  return Object.freeze(state);
}

function validOptionalBody(body: unknown): boolean {
  return body === undefined || isRecord(body);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
