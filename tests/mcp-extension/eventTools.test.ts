import { describe, expect, it } from "vitest";

import { debugHarness } from "./debugToolsHarness.js";

describe("ToolDispatcher event waits", () => {
  it("returns the first matching sequence after the cursor without acquiring the queue", async () => {
    const harness = debugHarness();
    const buffer = harness.eventBuffers.get(harness.selection.sessionRef)!;
    buffer.append({ kind: "output", output: "ignored" });
    const expected = buffer.append({ kind: "breakpoint" });
    buffer.append({ kind: "output", output: "later" });

    await expect(harness.dispatcher.call("unity_debug_wait_for_event", {
      sessionRef: harness.selection.sessionRef,
      afterSequence: 0,
      kinds: ["breakpoint", "output"],
      timeoutMs: 100,
    })).resolves.toEqual({
      sessionRef: harness.selection.sessionRef,
      state: "stopped",
      stopGeneration: 3,
      eventSequence: 11,
      event: { sequence: 1, kind: "output", output: "ignored" },
    });
    await expect(harness.dispatcher.call("unity_debug_wait_for_event", {
      sessionRef: harness.selection.sessionRef,
      afterSequence: 0,
      kinds: ["breakpoint"],
      timeoutMs: 100,
    })).resolves.toEqual({
      sessionRef: harness.selection.sessionRef,
      state: "stopped",
      stopGeneration: 3,
      eventSequence: 11,
      event: expected,
    });
    expect(harness.queue.reads).toBe(0);
    expect(harness.queue.writes).toBe(0);
  });

  it("honors pre-abort even when a buffered event matches", async () => {
    const harness = debugHarness();
    harness.eventBuffers.get(harness.selection.sessionRef)!.append({
      kind: "output",
      output: "buffered",
    });
    const controller = new AbortController();
    controller.abort();

    await expect(harness.dispatcher.call("unity_debug_wait_for_event", {
      sessionRef: harness.selection.sessionRef,
      afterSequence: 0,
      timeoutMs: 100,
    }, "client", controller.signal)).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("validates event filters and keeps waits scoped to the selected session buffer", async () => {
    const harness = debugHarness();
    await expect(harness.dispatcher.call("unity_debug_wait_for_event", {
      sessionRef: harness.selection.sessionRef,
      afterSequence: -1,
    })).rejects.toMatchObject({ code: "DAP_FAILURE" });
    await expect(harness.dispatcher.call("unity_debug_wait_for_event", {
      sessionRef: harness.selection.sessionRef,
      afterSequence: 0,
      kinds: ["private-event"],
    } as never)).rejects.toMatchObject({ code: "DAP_FAILURE" });
  });
});
