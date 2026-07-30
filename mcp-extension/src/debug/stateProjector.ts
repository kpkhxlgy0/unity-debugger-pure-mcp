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

const RELOAD_DETECTED_PREFIX = "Domain Reload detected; waiting for assemblies.";
const RELOAD_WAITING_PREFIX = "Waiting for assemblies after Domain Reload.";
const RELOAD_COMPLETE_PREFIX = "Domain Reload complete;";

export class StateProjector {
  #state: DebugSessionState = frozenState("starting", 0, 0);

  public snapshot(): DebugSessionState {
    return this.#state;
  }

  public acceptAdapterMessage(message: unknown): void {
    try {
      this.#acceptAdapterMessage(message);
    } catch {
      // Adapter messages are untrusted input; malformed accessors are ignored.
    }
  }

  #acceptAdapterMessage(message: unknown): void {
    if (!isRecord(message)) {
      return;
    }

    const type = message.type;
    if (
      type === "response" &&
      message.command === "attach" &&
      message.success === true
    ) {
      this.#moveOutsideStop("running");
      return;
    }

    const event = message.event;
    if (type !== "event" || typeof event !== "string") {
      return;
    }
    const body = message.body;

    switch (event) {
      case "stopped":
        this.#acceptStopped(body);
        return;
      case "continued":
        if (body === undefined || isRecord(body)) {
          this.#moveOutsideStop("running");
        }
        return;
      case "terminated":
        if (body === undefined || isRecord(body)) {
          this.#moveOutsideStop("terminated");
        }
        return;
      case "output":
        this.#acceptOutput(body);
        return;
      default:
        return;
    }
  }

  #acceptStopped(body: unknown): void {
    if (!isRecord(body)) {
      return;
    }
    const reason = body.reason;
    const threadId = body.threadId;
    if (!isNonEmptyString(reason)) {
      return;
    }
    if (
      threadId !== undefined &&
      !Number.isSafeInteger(threadId)
    ) {
      return;
    }

    this.#state = frozenState(
      "stopped",
      this.#state.stopGeneration + 1,
      this.#state.eventSequence + 1,
      reason,
      threadId as number | undefined,
    );
  }

  #acceptOutput(body: unknown): void {
    if (!isRecord(body)) {
      return;
    }
    const output = body.output;
    if (typeof output !== "string") {
      return;
    }
    if (
      output.startsWith(RELOAD_DETECTED_PREFIX) ||
      output.startsWith(RELOAD_WAITING_PREFIX)
    ) {
      this.#moveIntoReload();
      return;
    }
    if (output.startsWith(RELOAD_COMPLETE_PREFIX)) {
      this.#moveOutsideStop("running");
    }
  }

  #moveIntoReload(): void {
    const generation = this.#state.phase === "stopped"
      ? this.#state.stopGeneration + 1
      : this.#state.stopGeneration;
    this.#state = frozenState(
      "reloading",
      generation,
      this.#state.eventSequence + 1,
    );
  }

  #moveOutsideStop(phase: "running" | "terminated"): void {
    const invalidatesLiveGeneration =
      this.#state.phase === "stopped" || this.#state.phase === "reloading";
    this.#state = frozenState(
      phase,
      this.#state.stopGeneration + (invalidatesLiveGeneration ? 1 : 0),
      this.#state.eventSequence + 1,
    );
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
