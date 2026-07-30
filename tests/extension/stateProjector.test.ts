import { describe, expect, it } from "vitest";

import {
  EventSequencer,
  StateProjector,
} from "../../src/debug/stateProjector.js";

describe("StateProjector", () => {
  it("starts with an immutable starting snapshot and no optional stop data", () => {
    const projector = new StateProjector();
    const snapshot = projector.snapshot();

    expect(snapshot).toEqual({
      phase: "starting",
      stopGeneration: 0,
      eventSequence: 0,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.keys(snapshot)).toEqual(["phase", "stopGeneration", "eventSequence"]);
  });

  it("recognizes a successful attach response as running", () => {
    const projector = new StateProjector();

    const attachResult = projector.acceptAdapterMessage({
      type: "response",
      command: "attach",
      request_seq: 1,
      success: true,
      body: { privateData: "discarded" },
    });

    expect(attachResult).toBeUndefined();
    expect(projector.snapshot()).toEqual({
      phase: "running",
      stopGeneration: 0,
      eventSequence: 0,
    });
  });

  it("advances the generation on every stop and again when continue invalidates it", () => {
    const projector = new StateProjector();

    projector.acceptAdapterMessage({
      type: "event",
      event: "stopped",
      body: { reason: "breakpoint", threadId: 7 },
    });
    expect(projector.snapshot()).toEqual({
      phase: "stopped",
      stopGeneration: 1,
      eventSequence: 1,
      reason: "breakpoint",
      threadId: 7,
    });

    projector.acceptAdapterMessage({
      type: "event",
      event: "stopped",
      body: { reason: "step", threadId: 8 },
    });
    expect(projector.snapshot()).toMatchObject({
      phase: "stopped",
      stopGeneration: 2,
      eventSequence: 2,
      reason: "step",
      threadId: 8,
    });

    projector.acceptAdapterMessage({ type: "event", event: "continued", body: {} });
    expect(projector.snapshot()).toEqual({
      phase: "running",
      stopGeneration: 3,
      eventSequence: 3,
    });
  });

  it("accepts every safe integer DAP thread id, including zero", () => {
    const projector = new StateProjector();

    projector.acceptAdapterMessage({
      type: "event",
      event: "stopped",
      body: { reason: "entry", threadId: 0 },
    });

    expect(projector.snapshot()).toMatchObject({
      phase: "stopped",
      threadId: 0,
      reason: "entry",
    });
  });

  it("normalizes the actual Adapter reload order using only console output", () => {
    const projector = new StateProjector();
    projector.acceptAdapterMessage({
      type: "response",
      command: "attach",
      success: true,
    });
    projector.acceptAdapterMessage({
      type: "event",
      event: "stopped",
      body: { reason: "breakpoint", threadId: 9 },
    });
    projector.acceptAdapterMessage({ type: "event", event: "continued", body: {} });

    const reloadStarted = projector.acceptAdapterMessage({
      type: "event",
      event: "output",
      body: {
        category: "console",
        output: "Domain Reload detected; waiting for assemblies.\r\n",
      },
    });
    expect(projector.snapshot()).toEqual({
      phase: "reloading",
      stopGeneration: 2,
      eventSequence: 3,
    });
    expect(reloadStarted).toMatchObject({ sequence: 3, kind: "reload-started" });

    const reloadCompleted = projector.acceptAdapterMessage({
      type: "event",
      event: "output",
      body: {
        category: "console",
        output: "Domain Reload complete; 1 verified, 0 pending.\r\n",
      },
    });
    expect(projector.snapshot()).toEqual({
      phase: "running",
      stopGeneration: 3,
      eventSequence: 4,
    });
    expect(reloadCompleted).toMatchObject({ sequence: 4, kind: "reload-completed" });
  });

  it("ignores reload text with a wrong category, prefix, or current phase", () => {
    const projector = new StateProjector();
    const detected = "Domain Reload detected; waiting for assemblies.";
    const complete = "Domain Reload complete; 1 verified, 0 pending.";

    const ignored = [
      { type: "event", event: "output", body: { category: "console", output: detected } },
      { type: "event", event: "output", body: { category: "stdout", output: detected } },
      { type: "event", event: "output", body: { category: "console", output: `x${detected}` } },
      {
        type: "event",
        event: "output",
        body: { category: "console", output: "Waiting for assemblies after Domain Reload." },
      },
      { type: "event", event: "output", body: { category: "console", output: complete } },
    ];
    for (const message of ignored) {
      expect(projector.acceptAdapterMessage(message)).toBeUndefined();
    }
    expect(projector.snapshot()).toEqual({
      phase: "starting",
      stopGeneration: 0,
      eventSequence: 0,
    });

    projector.acceptAdapterMessage({ type: "response", command: "attach", success: true });
    const invalidWhileRunning = [
      { type: "event", event: "output", body: { category: "stdout", output: detected } },
      { type: "event", event: "output", body: { category: "console", output: `x${detected}` } },
      {
        type: "event",
        event: "output",
        body: { category: "console", output: "Waiting for assemblies after Domain Reload." },
      },
      { type: "event", event: "output", body: { category: "console", output: complete } },
    ];
    for (const message of invalidWhileRunning) {
      expect(projector.acceptAdapterMessage(message)).toBeUndefined();
    }
    expect(projector.snapshot()).toEqual({
      phase: "running",
      stopGeneration: 0,
      eventSequence: 0,
    });

    projector.acceptAdapterMessage({
      type: "event",
      event: "stopped",
      body: { reason: "pause", threadId: 2 },
    });
    expect(projector.acceptAdapterMessage({
      type: "event",
      event: "output",
      body: { category: "console", output: detected },
    })).toBeUndefined();
    expect(projector.snapshot().phase).toBe("stopped");
    projector.acceptAdapterMessage({ type: "event", event: "continued", body: {} });

    projector.acceptAdapterMessage({
      type: "event",
      event: "output",
      body: { category: "console", output: detected },
    });
    expect(projector.snapshot().phase).toBe("reloading");
    expect(projector.acceptAdapterMessage({
      type: "event",
      event: "output",
      body: { category: "console", output: detected },
    })).toBeUndefined();
    expect(projector.snapshot().eventSequence).toBe(3);
  });

  it("invalidates stopped or reloading generations on termination", () => {
    const stopped = new StateProjector();
    stopped.acceptAdapterMessage({
      type: "event",
      event: "stopped",
      body: { reason: "pause", threadId: 1 },
    });
    stopped.acceptAdapterMessage({ type: "event", event: "terminated", body: {} });
    expect(stopped.snapshot()).toEqual({
      phase: "terminated",
      stopGeneration: 2,
      eventSequence: 2,
    });

    const reloading = new StateProjector();
    reloading.acceptAdapterMessage({
      type: "response",
      command: "attach",
      success: true,
    });
    reloading.acceptAdapterMessage({
      type: "event",
      event: "output",
      body: {
        category: "console",
        output: "Domain Reload detected; waiting for assemblies.",
      },
    });
    reloading.acceptAdapterMessage({ type: "event", event: "terminated", body: {} });
    expect(reloading.snapshot()).toEqual({
      phase: "terminated",
      stopGeneration: 1,
      eventSequence: 2,
    });
  });

  it("keeps terminated terminal and ignores every late state-bearing message", () => {
    const projector = new StateProjector();
    projector.acceptAdapterMessage({ type: "event", event: "terminated", body: {} });
    const terminated = projector.snapshot();

    const lateMessages = [
      { type: "response", command: "attach", success: true },
      { type: "event", event: "stopped", body: { reason: "late", threadId: 4 } },
      { type: "event", event: "continued", body: {} },
      {
        type: "event",
        event: "output",
        body: {
          category: "console",
          output: "Domain Reload detected; waiting for assemblies.",
        },
      },
      {
        type: "event",
        event: "output",
        body: { category: "console", output: "Domain Reload complete; 0 verified." },
      },
      { type: "event", event: "terminated", body: {} },
    ];
    for (const message of lateMessages) {
      expect(projector.acceptAdapterMessage(message)).toBeUndefined();
    }

    expect(projector.snapshot()).toBe(terminated);
    expect(projector.snapshot()).toEqual({
      phase: "terminated",
      stopGeneration: 0,
      eventSequence: 1,
    });
  });

  it("allocates each normalized state event once from a shared sequencer", () => {
    const sequencer = new EventSequencer();
    const projector = new StateProjector(sequencer);
    projector.acceptAdapterMessage({ type: "response", command: "attach", success: true });

    const stopped = projector.acceptAdapterMessage({
      type: "event",
      event: "stopped",
      body: { reason: "breakpoint", threadId: 11 },
    });

    expect(stopped).toEqual({
      sequence: 1,
      kind: "stopped",
      state: projector.snapshot(),
    });
    expect(sequencer.current).toBe(1);
    expect(Object.isFrozen(stopped)).toBe(true);

    // A future EventBuffer consumes stopped.sequence as-is; it must not call next().
    const alreadyNumberedForBuffer = stopped!.sequence;
    expect(alreadyNumberedForBuffer).toBe(1);
    expect(sequencer.current).toBe(1);

    expect(sequencer.next()).toBe(2);
    expect(projector.snapshot()).toEqual({
      phase: "stopped",
      stopGeneration: 1,
      eventSequence: 2,
      reason: "breakpoint",
      threadId: 11,
    });
  });

  it("ignores malformed and unrelated messages without advancing sequence", () => {
    const projector = new StateProjector();
    const ignored = [
      null,
      { type: "response", command: "attach", success: false },
      { type: "response", command: "launch", success: true },
      { type: "event", event: "stopped", body: { reason: 7, threadId: 1 } },
      { type: "event", event: "stopped", body: { reason: "breakpoint", threadId: 1.5 } },
      { type: "event", event: "continued", body: "bad" },
      { type: "event", event: "terminated", body: [] },
      { type: "event", event: "output", body: { output: "prefix Domain Reload detected" } },
      { type: "event", event: "thread", body: { reason: "started", threadId: 1 } },
    ];

    for (const message of ignored) {
      projector.acceptAdapterMessage(message);
    }

    expect(projector.snapshot()).toEqual({
      phase: "starting",
      stopGeneration: 0,
      eventSequence: 0,
    });
  });

  it("ignores malformed messages whose properties throw", () => {
    const projector = new StateProjector();
    const malformed = new Proxy({}, {
      get() {
        throw new Error("private adapter payload");
      },
    });

    expect(() => projector.acceptAdapterMessage(malformed)).not.toThrow();
    expect(projector.snapshot()).toEqual({
      phase: "starting",
      stopGeneration: 0,
      eventSequence: 0,
    });
  });

  it("never retains raw output, source, variables, or mutable prior snapshots", () => {
    const projector = new StateProjector();
    const initial = projector.snapshot();
    projector.acceptAdapterMessage({
      type: "event",
      event: "stopped",
      body: {
        reason: "breakpoint",
        threadId: 3,
        source: { path: "C:\\private\\Player.cs" },
        variables: [{ name: "password", value: "secret" }],
        output: "token-value",
      },
    });

    const stopped = projector.snapshot();
    expect(initial).toEqual({ phase: "starting", stopGeneration: 0, eventSequence: 0 });
    expect(JSON.stringify(stopped)).toBe(
      '{"phase":"stopped","stopGeneration":1,"eventSequence":1,"reason":"breakpoint","threadId":3}',
    );
    expect(Object.isFrozen(stopped)).toBe(true);
  });
});
