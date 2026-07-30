import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EventBuffer,
  NORMALIZED_EVENT_KINDS,
  type NormalizedEventRecord,
} from "../../src/debug/eventBuffer.js";
import type { StructuredToolError } from "../../src/tools/errors.js";
import {
  EventSequencer,
  StateProjector,
  type EventSequenceCursor,
  type ProjectedStateEvent,
} from "../../src/debug/stateProjector.js";

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

function projected(
  sequence: number,
  kind: ProjectedStateEvent["kind"],
  phase: ProjectedStateEvent["state"]["phase"],
  stopGeneration: number,
): ProjectedStateEvent {
  const reason = kind === "stopped" ? "breakpoint" : undefined;
  return Object.freeze({
    sequence,
    kind,
    state: Object.freeze({
      phase,
      stopGeneration,
      eventSequence: sequence,
      ...(reason === undefined ? {} : { reason }),
    }),
  });
}

function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("EventBuffer", () => {
  it("defines only the eight normalized event kinds from the bridge contract", () => {
    expect(NORMALIZED_EVENT_KINDS).toEqual([
      "stopped",
      "continued",
      "breakpoint",
      "reload-started",
      "reload-progress",
      "reload-completed",
      "output",
      "terminated",
    ]);
  });

  it("uses one shared sequence authority across projected and ordinary events", async () => {
    const cursor = new EventSequencer();
    const projector = new StateProjector(cursor);
    const buffer = new EventBuffer(cursor);
    projector.acceptAdapterMessage({ type: "response", command: "attach", success: true });

    const stopped = projector.acceptAdapterMessage({
      type: "event",
      event: "stopped",
      body: { reason: "breakpoint", threadId: 91 },
    });
    const first = buffer.appendProjected(stopped!);
    const second = buffer.append({ kind: "output", output: "safe output" });
    const continued = projector.acceptAdapterMessage({
      type: "event",
      event: "continued",
      body: {},
    });
    const third = buffer.appendProjected(continued!);

    expect([first.sequence, second.sequence, third.sequence]).toEqual([1, 2, 3]);
    expect(cursor.current).toBe(3);
    await expect(buffer.waitFor(0, undefined, 0)).resolves.toEqual(first);
    await expect(buffer.waitFor(1, undefined, 0)).resolves.toEqual(second);
    await expect(buffer.waitFor(2, undefined, 0)).resolves.toEqual(third);
  });

  it("calls next exactly once for an ordinary event and rejects cursor gaps", () => {
    let current = 0;
    let calls = 0;
    const cursor: EventSequenceCursor = {
      get current() {
        return current;
      },
      next() {
        calls += 1;
        current += 1;
        return current;
      },
    };
    const buffer = new EventBuffer(cursor);

    expect(buffer.append({ kind: "breakpoint" }).sequence).toBe(1);
    expect(calls).toBe(1);
    current = 3;
    expect(() => buffer.append({ kind: "output", output: "late" })).toThrow(
      "Event sequence cursor is not synchronized with the buffer.",
    );
    expect(calls).toBe(1);
  });

  it("rejects malformed ordinary events without consuming a sequence", () => {
    const cursor = new EventSequencer();
    const buffer = new EventBuffer(cursor);

    expect(() => buffer.append({ kind: "output" } as { kind: "output"; output: string })).toThrow(
      "Normalized output must be a string.",
    );
    expect(cursor.current).toBe(0);
    expect(buffer.append({ kind: "breakpoint" }).sequence).toBe(1);
  });

  it("rejects duplicate, skipped, and non-current projected sequences", () => {
    const cursor = new EventSequencer();
    const buffer = new EventBuffer(cursor);
    cursor.next();
    const first = projected(1, "stopped", "stopped", 1);

    expect(buffer.appendProjected(first).sequence).toBe(1);
    expect(() => buffer.appendProjected(first)).toThrow(
      "Projected event sequence is not the next current sequence.",
    );

    cursor.next();
    cursor.next();
    expect(() => buffer.appendProjected(projected(3, "continued", "running", 2))).toThrow(
      "Projected event sequence is not the next current sequence.",
    );
    expect(() => buffer.appendProjected(projected(2, "continued", "running", 2))).toThrow(
      "Projected event sequence is not the next current sequence.",
    );
  });

  it("rejects projected events whose kind, phase, and reason are inconsistent", () => {
    const invalidEvents: readonly ProjectedStateEvent[] = [
      projected(1, "stopped", "running", 1),
      {
        ...projected(1, "stopped", "stopped", 1),
        state: { phase: "stopped", stopGeneration: 1, eventSequence: 1, reason: "" },
      },
      projected(1, "continued", "stopped", 2),
      {
        ...projected(1, "continued", "running", 2),
        state: {
          phase: "running",
          stopGeneration: 2,
          eventSequence: 1,
          reason: "stale reason",
        },
      },
      projected(1, "reload-started", "running", 2),
      projected(1, "reload-completed", "reloading", 3),
      projected(1, "terminated", "running", 3),
    ];

    for (const event of invalidEvents) {
      const cursor = new EventSequencer();
      const buffer = new EventBuffer(cursor);
      cursor.next();
      expect(() => buffer.appendProjected(event)).toThrow(
        "Projected event kind and state are inconsistent.",
      );
    }
  });

  it("projects state fields without retaining thread IDs or arbitrary DAP payload", () => {
    const cursor = new EventSequencer();
    const buffer = new EventBuffer(cursor);
    cursor.next();
    const event = {
      sequence: 1,
      kind: "stopped",
      state: {
        phase: "stopped",
        stopGeneration: 7,
        eventSequence: 1,
        reason: "breakpoint",
        threadId: 812,
        source: "C:\\private\\Player.cs",
        variables: [{ value: "secret" }],
      },
      expression: "password",
      value: "secret",
    } as unknown as ProjectedStateEvent;

    const stored = buffer.appendProjected(event);

    expect(stored).toEqual({
      sequence: 1,
      kind: "stopped",
      phase: "stopped",
      stopGeneration: 7,
      reason: "breakpoint",
    });
    expect(JSON.stringify(stored)).not.toMatch(/812|private|Player|variables|password|secret/);
    expect(Object.isFrozen(stored)).toBe(true);
  });

  it("keeps only normalized output and truncates it at a valid 65,536-byte UTF-8 boundary", () => {
    const cursor = new EventSequencer();
    const buffer = new EventBuffer(cursor);
    const oversized = `${"a".repeat(65_535)}😀`;

    const stored = buffer.append({
      kind: "output",
      output: oversized,
      source: "C:\\private\\Player.cs",
      expression: "password",
      value: "secret",
      payload: { variablesReference: 99 },
    } as unknown as { kind: "output"; output: string });

    expect(Object.keys(stored)).toEqual(["sequence", "kind", "output"]);
    expect(Buffer.byteLength(stored.output!, "utf8")).toBeLessThanOrEqual(65_536);
    expect(stored.output).toBe("a".repeat(65_535));
    expect(stored.output).not.toContain("�");
    expect(JSON.stringify(stored)).not.toMatch(/private|Player|password|secret|variablesReference/);
  });

  it("retains the newest 256 events while sequence numbers remain monotonic", async () => {
    const buffer = new EventBuffer(new EventSequencer());
    let last: NormalizedEventRecord | undefined;

    for (let index = 1; index <= 257; index += 1) {
      last = buffer.append({ kind: "output", output: `event-${index}` });
    }

    expect(last).toMatchObject({ sequence: 257, output: "event-257" });
    await expect(buffer.waitFor(0, ["output"], 0)).resolves.toMatchObject({
      sequence: 2,
      output: "event-2",
    });
    await expect(buffer.waitFor(256, ["output"], 0)).resolves.toMatchObject({
      sequence: 257,
      output: "event-257",
    });
  });

  it("returns the first event after the requested sequence that matches the kind filter", async () => {
    const buffer = new EventBuffer(new EventSequencer());
    buffer.append({ kind: "output", output: "one" });
    buffer.append({ kind: "breakpoint" });
    buffer.append({ kind: "reload-progress", output: "three" });
    buffer.append({ kind: "output", output: "four" });

    await expect(buffer.waitFor(1, ["reload-progress", "output"], 0)).resolves.toEqual({
      sequence: 3,
      kind: "reload-progress",
      output: "three",
    });
  });

  it("does not lose an event appended immediately after waiter registration", async () => {
    vi.useFakeTimers();
    const buffer = new EventBuffer(new EventSequencer());

    const waiting = buffer.waitFor(0, ["breakpoint"], 30_000);
    const appended = buffer.append({ kind: "breakpoint" });

    await expect(waiting).resolves.toBe(appended);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("supports multiple waiters with independent kind filters", async () => {
    vi.useFakeTimers();
    const buffer = new EventBuffer(new EventSequencer());
    const outputWaiter = buffer.waitFor(0, ["output"], 30_000);
    const breakpointWaiter = buffer.waitFor(0, ["breakpoint"], 30_000);

    const breakpoint = buffer.append({ kind: "breakpoint" });
    await expect(breakpointWaiter).resolves.toBe(breakpoint);
    expect(vi.getTimerCount()).toBe(1);

    const output = buffer.append({ kind: "output", output: "done" });
    await expect(outputWaiter).resolves.toBe(output);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses a 30-second default timeout and returns the stable frozen TIMEOUT error", async () => {
    vi.useFakeTimers();
    const buffer = new EventBuffer(new EventSequencer());
    const firstError = rejectionOf(buffer.waitFor(0));

    await vi.advanceTimersByTimeAsync(29_999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    const first = await firstError;

    const secondError = rejectionOf(buffer.waitFor(0));
    await vi.advanceTimersByTimeAsync(30_000);
    const second = await secondError;

    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first).toEqual({
      code: "TIMEOUT",
      message: "No matching debugger event arrived before the timeout.",
      retryable: true,
      currentState: "unchanged",
      action: "Retry with a later timeout or inspect the current debugger status.",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a pre-aborted wait even when a matching event is already buffered", async () => {
    const buffer = new EventBuffer(new EventSequencer());
    buffer.append({ kind: "breakpoint" });
    const controller = new AbortController();
    controller.abort();

    await expect(buffer.waitFor(0, ["breakpoint"], 30_000, controller.signal)).rejects.toEqual({
      code: "CANCELLED",
      message: "The debugger event wait was cancelled.",
      retryable: true,
      currentState: "unchanged",
      action: "Retry the wait if the event is still needed.",
    });
  });

  it("clamps requested timeouts to the inclusive zero-to-60-second range", async () => {
    vi.useFakeTimers();
    const buffer = new EventBuffer(new EventSequencer());
    const maximumError = rejectionOf(buffer.waitFor(0, undefined, 90_000));

    await vi.advanceTimersByTimeAsync(59_999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await maximumError).toMatchObject({ code: "TIMEOUT" });

    const zeroError = rejectionOf(buffer.waitFor(0, undefined, -1));
    await vi.advanceTimersByTimeAsync(0);
    expect(await zeroError).toMatchObject({ code: "TIMEOUT" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("handles NaN and signed infinities with explicit clamped timeout semantics", async () => {
    vi.useFakeTimers();
    const buffer = new EventBuffer(new EventSequencer());
    const notANumber = rejectionOf(buffer.waitFor(0, undefined, Number.NaN));
    const positiveInfinity = rejectionOf(buffer.waitFor(0, undefined, Number.POSITIVE_INFINITY));
    const negativeInfinity = rejectionOf(buffer.waitFor(0, undefined, Number.NEGATIVE_INFINITY));

    await vi.advanceTimersByTimeAsync(0);
    expect(await negativeInfinity).toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(vi.getTimerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await notANumber).toMatchObject({ code: "TIMEOUT" });
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await positiveInfinity).toMatchObject({ code: "TIMEOUT" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels pre-aborted and active waits with one stable error and cleans timers/listeners", async () => {
    vi.useFakeTimers();
    const buffer = new EventBuffer(new EventSequencer());
    const preAborted = new AbortController();
    preAborted.abort();

    const first = await rejectionOf(buffer.waitFor(0, undefined, 30_000, preAborted.signal));
    expect(vi.getTimerCount()).toBe(0);

    const active = new AbortController();
    const removeListener = vi.spyOn(active.signal, "removeEventListener");
    const activeError = rejectionOf(buffer.waitFor(0, undefined, 30_000, active.signal));
    expect(vi.getTimerCount()).toBe(1);
    active.abort();
    const second = await activeError;

    expect(first).toBe(second);
    expect(Object.isFrozen(second)).toBe(true);
    expect(second).toEqual({
      code: "CANCELLED",
      message: "The debugger event wait was cancelled.",
      retryable: true,
      currentState: "unchanged",
      action: "Retry the wait if the event is still needed.",
    });
    expect(removeListener).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    buffer.append({ kind: "output", output: "late" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await activeError).toBe(second);
  });

  it("invalidates all pending and future waits with the lifecycle error and clears timers", async () => {
    vi.useFakeTimers();
    const buffer = new EventBuffer(new EventSequencer());
    const lifecycleError = Object.freeze({
      code: "NOT_ATTACHED",
      message: "No matching Unity debugger session is attached.",
      retryable: true,
      currentState: "detached",
      action: "Attach to a debugger target and retry the request.",
    }) satisfies StructuredToolError;
    const first = rejectionOf(buffer.waitFor(0, ["output"], 60_000));
    const second = rejectionOf(buffer.waitFor(0, ["breakpoint"], 60_000));
    expect(vi.getTimerCount()).toBe(2);

    buffer.invalidate(lifecycleError);

    expect(await first).toBe(lifecycleError);
    expect(await second).toBe(lifecycleError);
    await expect(buffer.waitFor(0, undefined, 60_000)).rejects.toBe(lifecycleError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns frozen records from both immediate scans and waiter resolution", async () => {
    vi.useFakeTimers();
    const buffer = new EventBuffer(new EventSequencer());
    const first = buffer.append({ kind: "output", output: "first" });
    const immediate = await buffer.waitFor(0, undefined, 30_000);
    const waiting = buffer.waitFor(1, undefined, 30_000);
    const second = buffer.append({ kind: "breakpoint" });
    const resolved = await waiting;

    expect(immediate).toBe(first);
    expect(resolved).toBe(second);
    expect(Object.isFrozen(immediate)).toBe(true);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
