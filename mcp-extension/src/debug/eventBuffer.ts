import { TextDecoder } from "node:util";

import type { StructuredToolError } from "../tools/errors.js";
import type {
  DebugPhase,
  EventSequenceCursor,
  ProjectedStateEvent,
} from "./stateProjector.js";

const EVENT_CAPACITY = 256;
const MAX_OUTPUT_BYTES = 65_536;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;

export const NORMALIZED_EVENT_KINDS = Object.freeze([
  "stopped",
  "continued",
  "breakpoint",
  "reload-started",
  "reload-progress",
  "reload-completed",
  "output",
  "terminated",
] as const);

export type NormalizedEventKind = (typeof NORMALIZED_EVENT_KINDS)[number];

export type OrdinaryEventInput =
  | Readonly<{ kind: "breakpoint" }>
  | Readonly<{ kind: "reload-progress"; output: string }>
  | Readonly<{ kind: "output"; output: string }>;

export interface NormalizedEventRecord {
  readonly sequence: number;
  readonly kind: NormalizedEventKind;
  readonly phase?: DebugPhase;
  readonly stopGeneration?: number;
  readonly reason?: string;
  readonly output?: string;
}

interface EventWaiter {
  readonly afterSequence: number;
  readonly kinds: ReadonlySet<NormalizedEventKind> | undefined;
  readonly resolve: (event: NormalizedEventRecord) => void;
  readonly reject: (error: StructuredToolError) => void;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: () => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  settled: boolean;
}

const TIMEOUT_ERROR: StructuredToolError = Object.freeze({
  code: "TIMEOUT",
  message: "No matching debugger event arrived before the timeout.",
  retryable: true,
  currentState: "unchanged",
  action: "Retry with a later timeout or inspect the current debugger status.",
});

const CANCELLED_ERROR: StructuredToolError = Object.freeze({
  code: "CANCELLED",
  message: "The debugger event wait was cancelled.",
  retryable: true,
  currentState: "unchanged",
  action: "Retry the wait if the event is still needed.",
});

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const EVENT_KIND_SET = new Set<string>(NORMALIZED_EVENT_KINDS);
const PROJECTED_KIND_SET = new Set<string>([
  "stopped",
  "continued",
  "reload-started",
  "reload-completed",
  "terminated",
]);
const PHASE_SET = new Set<string>([
  "starting",
  "running",
  "stopped",
  "reloading",
  "terminated",
]);
const PROJECTED_PHASES: Readonly<Record<ProjectedStateEvent["kind"], DebugPhase>> =
  Object.freeze({
    stopped: "stopped",
    continued: "running",
    "reload-started": "reloading",
    "reload-completed": "running",
    terminated: "terminated",
  });

/** A bounded, sequenced event ring belonging to one debug session. */
export class EventBuffer {
  readonly #cursor: EventSequenceCursor;
  readonly #events: NormalizedEventRecord[] = [];
  readonly #waiters = new Set<EventWaiter>();
  #invalidatedError: StructuredToolError | undefined;
  #lastSequence: number;

  public constructor(cursor: EventSequenceCursor) {
    this.#cursor = cursor;
    this.#lastSequence = cursor.current;
  }

  public append(input: OrdinaryEventInput): NormalizedEventRecord {
    let kind: OrdinaryEventInput["kind"];
    let output: string | undefined;
    if (input.kind === "breakpoint") {
      kind = "breakpoint";
    } else if (input.kind === "reload-progress" || input.kind === "output") {
      if (typeof input.output !== "string") {
        throw new TypeError("Normalized output must be a string.");
      }
      kind = input.kind;
      output = truncateUtf8(input.output);
    } else {
      throw new TypeError("Unsupported ordinary event kind.");
    }

    if (this.#cursor.current !== this.#lastSequence) {
      throw new Error("Event sequence cursor is not synchronized with the buffer.");
    }
    const sequence = this.#cursor.next();
    if (sequence !== this.#lastSequence + 1) {
      throw new Error("Event sequence cursor did not allocate the next sequence.");
    }

    let record: NormalizedEventRecord;
    if (kind === "breakpoint") {
      record = Object.freeze({ sequence, kind: "breakpoint" });
    } else {
      record = Object.freeze({
        sequence,
        kind,
        output: output!,
      });
    }

    return this.#store(record);
  }

  public appendProjected(event: ProjectedStateEvent): NormalizedEventRecord {
    if (
      !Number.isSafeInteger(event.sequence) ||
      event.sequence <= 0 ||
      event.sequence !== this.#cursor.current ||
      event.sequence !== this.#lastSequence + 1
    ) {
      throw new Error("Projected event sequence is not the next current sequence.");
    }
    if (!PROJECTED_KIND_SET.has(event.kind)) {
      throw new TypeError("Unsupported projected event kind.");
    }

    const state = event.state;
    if (
      state.eventSequence !== event.sequence ||
      !PHASE_SET.has(state.phase) ||
      !Number.isSafeInteger(state.stopGeneration) ||
      state.stopGeneration < 0
    ) {
      throw new TypeError("Projected event state is invalid.");
    }
    const hasValidReason =
      event.kind === "stopped"
        ? typeof state.reason === "string" && state.reason.length > 0
        : state.reason === undefined;
    if (state.phase !== PROJECTED_PHASES[event.kind] || !hasValidReason) {
      throw new TypeError("Projected event kind and state are inconsistent.");
    }

    const normalized: {
      sequence: number;
      kind: ProjectedStateEvent["kind"];
      phase: DebugPhase;
      stopGeneration: number;
      reason?: string;
    } = {
      sequence: event.sequence,
      kind: event.kind,
      phase: state.phase,
      stopGeneration: state.stopGeneration,
    };
    if (event.kind === "stopped" && typeof state.reason === "string") {
      normalized.reason = state.reason;
    }

    return this.#store(Object.freeze(normalized));
  }

  public waitFor(
    afterSequence: number,
    kinds?: readonly NormalizedEventKind[],
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<NormalizedEventRecord> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      return Promise.reject(new TypeError("afterSequence must be a non-negative safe integer."));
    }
    const normalizedKinds = normalizeKinds(kinds);
    if (this.#invalidatedError !== undefined) {
      return Promise.reject(this.#invalidatedError);
    }
    if (signal?.aborted === true) {
      return Promise.reject(CANCELLED_ERROR);
    }
    const existing = this.#find(afterSequence, normalizedKinds);
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }

    return new Promise<NormalizedEventRecord>((resolve, reject) => {
      const waiter: EventWaiter = {
        afterSequence,
        kinds: normalizedKinds,
        resolve,
        reject,
        signal,
        onAbort: () => this.#reject(waiter, CANCELLED_ERROR),
        timer: undefined,
        settled: false,
      };
      this.#waiters.add(waiter);
      waiter.timer = setTimeout(
        () => this.#reject(waiter, TIMEOUT_ERROR),
        clampTimeout(timeoutMs),
      );
      signal?.addEventListener("abort", waiter.onAbort, { once: true });

      // Rescan after registration so a future asynchronous implementation cannot
      // open a lost-event window between the initial scan and waiter visibility.
      const raced = this.#find(afterSequence, normalizedKinds);
      if (raced !== undefined) {
        this.#resolve(waiter, raced);
      }
    });
  }

  public invalidate(error: StructuredToolError): void {
    if (this.#invalidatedError !== undefined) {
      return;
    }
    this.#invalidatedError = error;
    for (const waiter of [...this.#waiters]) {
      this.#reject(waiter, error);
    }
  }

  #store(record: NormalizedEventRecord): NormalizedEventRecord {
    this.#lastSequence = record.sequence;
    this.#events.push(record);
    if (this.#events.length > EVENT_CAPACITY) {
      this.#events.shift();
    }

    for (const waiter of [...this.#waiters]) {
      if (matches(record, waiter.afterSequence, waiter.kinds)) {
        this.#resolve(waiter, record);
      }
    }
    return record;
  }

  #find(
    afterSequence: number,
    kinds: ReadonlySet<NormalizedEventKind> | undefined,
  ): NormalizedEventRecord | undefined {
    return this.#events.find((event) => matches(event, afterSequence, kinds));
  }

  #resolve(waiter: EventWaiter, event: NormalizedEventRecord): void {
    if (!this.#settle(waiter)) {
      return;
    }
    waiter.resolve(event);
  }

  #reject(waiter: EventWaiter, error: StructuredToolError): void {
    if (!this.#settle(waiter)) {
      return;
    }
    waiter.reject(error);
  }

  #settle(waiter: EventWaiter): boolean {
    if (waiter.settled) {
      return false;
    }
    waiter.settled = true;
    this.#waiters.delete(waiter);
    if (waiter.timer !== undefined) {
      clearTimeout(waiter.timer);
      waiter.timer = undefined;
    }
    waiter.signal?.removeEventListener("abort", waiter.onAbort);
    return true;
  }
}

function normalizeKinds(
  kinds: readonly NormalizedEventKind[] | undefined,
): ReadonlySet<NormalizedEventKind> | undefined {
  if (kinds === undefined) {
    return undefined;
  }
  const normalized = new Set<NormalizedEventKind>();
  for (const kind of kinds) {
    if (!EVENT_KIND_SET.has(kind)) {
      throw new TypeError("Unsupported normalized event kind.");
    }
    normalized.add(kind);
  }
  return normalized;
}

function matches(
  event: NormalizedEventRecord,
  afterSequence: number,
  kinds: ReadonlySet<NormalizedEventKind> | undefined,
): boolean {
  return event.sequence > afterSequence && (kinds === undefined || kinds.has(event.kind));
}

function clampTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || Number.isNaN(timeoutMs)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(MAX_TIMEOUT_MS, Math.max(0, Math.trunc(timeoutMs)));
}

function truncateUtf8(output: string): string {
  const bytes = Buffer.from(output, "utf8");
  if (bytes.byteLength <= MAX_OUTPUT_BYTES) {
    return output;
  }

  for (let end = MAX_OUTPUT_BYTES; end >= MAX_OUTPUT_BYTES - 3; end -= 1) {
    try {
      return UTF8_DECODER.decode(bytes.subarray(0, end));
    } catch {
      // A UTF-8 scalar may span at most four bytes, so one of these boundaries
      // is valid for a prefix produced by Node's UTF-8 encoder.
    }
  }
  throw new Error("Unable to truncate normalized output at a UTF-8 boundary.");
}
