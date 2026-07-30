import { describe, expect, it } from "vitest";

import {
  assertNoRawDapHandleKeys,
  debugHarness,
  defaultDapResponse,
  makeDebugSession,
} from "./debugToolsHarness.js";

describe("ToolDispatcher inspection and evaluation", () => {
  it("translates every DAP handle to generation-bound opaque references", async () => {
    const { dispatcher, selection } = debugHarness();
    const threads = await dispatcher.call("unity_debug_threads", {
      sessionRef: selection.sessionRef,
    }) as { threads: Array<{ threadRef: string }> };
    const stack = await dispatcher.call("unity_debug_stack_trace", {
      sessionRef: selection.sessionRef,
      threadRef: threads.threads[0].threadRef,
    }) as { frames: Array<{ frameRef: string }> };
    const scopes = await dispatcher.call("unity_debug_scopes", {
      sessionRef: selection.sessionRef,
      frameRef: stack.frames[0].frameRef,
    }) as { scopes: Array<{ variablesRef: string }> };
    const variables = await dispatcher.call("unity_debug_variables", {
      sessionRef: selection.sessionRef,
      variablesRef: scopes.scopes[1].variablesRef,
    }) as { variables: Array<{ variablesRef?: string }> };

    for (const result of [threads, stack, scopes, variables]) {
      expect(result).toMatchObject({
        sessionRef: selection.sessionRef,
        state: "stopped",
        stopGeneration: 3,
        eventSequence: 11,
      });
    }

    expect(threads).toMatchObject({
      stopGeneration: 3,
      threads: [{ name: "Main Thread" }, { name: "Worker" }],
    });
    expect(stack).toMatchObject({
      stopGeneration: 3,
      frames: [{ name: "Update", line: 12 }, { name: "Loop", line: 44 }],
    });
    expect(scopes).toMatchObject({ scopes: [{ name: "Expensive" }, { name: "Locals" }] });
    expect(variables.variables[1]).toMatchObject({ name: "player", variablesRef: expect.any(String) });
    expect(() => assertNoRawDapHandleKeys({ threads, stack, scopes, variables })).not.toThrow();
    expect(JSON.stringify({ threads, stack, scopes, variables })).not.toContain("raw-session-id");
  });

  it("accepts child-variable collection refs and rejects thread/frame/wrong-session refs", async () => {
    const harness = debugHarness();
    const threads = await harness.dispatcher.call("unity_debug_threads", {
      sessionRef: harness.selection.sessionRef,
    }) as { threads: Array<{ threadRef: string }> };
    await expect(harness.dispatcher.call("unity_debug_variables", {
      sessionRef: harness.selection.sessionRef,
      variablesRef: threads.threads[0].threadRef,
    })).rejects.toMatchObject({ code: "STALE_REFERENCE" });

    const stack = await harness.dispatcher.call("unity_debug_stack_trace", {
      sessionRef: harness.selection.sessionRef,
      threadRef: threads.threads[0].threadRef,
    }) as { frames: Array<{ frameRef: string }> };
    await expect(harness.dispatcher.call("unity_debug_variables", {
      sessionRef: harness.selection.sessionRef,
      variablesRef: stack.frames[0].frameRef,
    })).rejects.toMatchObject({ code: "STALE_REFERENCE" });

    const scopes = await harness.dispatcher.call("unity_debug_scopes", {
      sessionRef: harness.selection.sessionRef,
      frameRef: stack.frames[0].frameRef,
    }) as { scopes: Array<{ variablesRef: string }> };
    const first = await harness.dispatcher.call("unity_debug_variables", {
      sessionRef: harness.selection.sessionRef,
      variablesRef: scopes.scopes[1].variablesRef,
    }) as { variables: Array<{ variablesRef?: string }> };
    await expect(harness.dispatcher.call("unity_debug_variables", {
      sessionRef: harness.selection.sessionRef,
      variablesRef: first.variables[1].variablesRef,
    })).resolves.toMatchObject({ variables: expect.any(Array) });

    const other = makeDebugSession("other-raw-id", async (command) => defaultDapResponse(command));
    const otherSelection = harness.sessions.register(other, true)!;
    harness.states.set(other.id, Object.freeze({
      phase: "stopped",
      stopGeneration: 3,
      eventSequence: 1,
      reason: "pause",
      threadId: 71,
    }));
    await expect(harness.dispatcher.call("unity_debug_stack_trace", {
      sessionRef: otherSelection.sessionRef,
      threadRef: threads.threads[0].threadRef,
    })).rejects.toMatchObject({ code: "STALE_REFERENCE" });
  });

  it.each([
    ["running", "NOT_STOPPED"],
    ["starting", "NOT_STOPPED"],
    ["reloading", "RELOADING"],
    ["terminated", "NOT_ATTACHED"],
  ] as const)("rejects inspection while session is %s", async (phase, code) => {
    const harness = debugHarness();
    harness.states.set(harness.session.id, Object.freeze({
      phase,
      stopGeneration: 3,
      eventSequence: 12,
    }));

    await expect(harness.dispatcher.call("unity_debug_threads", {
      sessionRef: harness.selection.sessionRef,
    })).rejects.toMatchObject({ code });
    expect(harness.customRequest).not.toHaveBeenCalled();
  });

  it("invalidates prior-generation references and rejects results if generation changes mid-await", async () => {
    let release!: (value: unknown) => void;
    const harness = debugHarness({
      customRequest: async (command) => command === "threads"
        ? new Promise((resolve) => { release = resolve; })
        : defaultDapResponse(command),
    });
    const pending = harness.dispatcher.call("unity_debug_threads", {
      sessionRef: harness.selection.sessionRef,
    });
    await Promise.resolve();
    harness.states.set(harness.session.id, Object.freeze({
      phase: "stopped",
      stopGeneration: 4,
      eventSequence: 12,
      reason: "step",
      threadId: 71,
    }));
    release(defaultDapResponse("threads"));

    await expect(pending).rejects.toMatchObject({ code: "STALE_REFERENCE" });
    expect(harness.references.activeReferenceCount).toBe(0);
  });

  it("publishes a fresh event cursor when sequence advances during a DAP await", async () => {
    let release!: (value: unknown) => void;
    const harness = debugHarness({
      customRequest: async (command) => command === "threads"
        ? new Promise((resolve) => { release = resolve; })
        : defaultDapResponse(command),
    });
    const pending = harness.dispatcher.call("unity_debug_threads", {
      sessionRef: harness.selection.sessionRef,
    });
    await Promise.resolve();
    await Promise.resolve();
    harness.states.set(harness.session.id, Object.freeze({
      phase: "stopped",
      stopGeneration: 3,
      eventSequence: 99,
      reason: "breakpoint",
      threadId: 71,
    }));
    release(defaultDapResponse("threads"));

    await expect(pending).resolves.toMatchObject({
      state: "stopped",
      stopGeneration: 3,
      eventSequence: 99,
    });
  });

  it("performs snapshot in one read, exact bounded order, and no recursive expansion", async () => {
    const harness = debugHarness();

    const snapshot = await harness.dispatcher.call("unity_debug_snapshot", {
      sessionRef: harness.selection.sessionRef,
    }) as { frames: unknown[]; variables: unknown[] };

    expect(harness.queue.reads).toBe(1);
    expect(harness.customRequest.mock.calls.map(([command, body]) => [command, body])).toEqual([
      ["threads", {}],
      ["stackTrace", { threadId: 71, startFrame: 0, levels: 20 }],
      ["scopes", { frameId: 401 }],
      ["variables", { variablesReference: 502, start: 0, count: 100 }],
    ]);
    expect(snapshot.frames).toHaveLength(2);
    expect(snapshot.variables).toHaveLength(2);
    expect(snapshot).toMatchObject({
      sessionRef: harness.selection.sessionRef,
      state: "stopped",
      stopGeneration: 3,
      eventSequence: 11,
    });
    expect(() => assertNoRawDapHandleKeys(snapshot)).not.toThrow();
  });

  it("does not allocate partial snapshot refs when a later DAP request fails", async () => {
    const harness = debugHarness({
      customRequest: async (command) => {
        if (command === "scopes") throw new Error("C:\\private\\failure.log");
        return defaultDapResponse(command);
      },
    });

    await expect(harness.dispatcher.call("unity_debug_snapshot", {
      sessionRef: harness.selection.sessionRef,
    })).rejects.toMatchObject({ code: "DAP_FAILURE" });
    expect(harness.references.activeReferenceCount).toBe(0);
  });

  it("uses hover for safe evaluation, requires explicit consent, and bounds expressions", async () => {
    const harness = debugHarness();
    const threads = await harness.dispatcher.call("unity_debug_threads", {
      sessionRef: harness.selection.sessionRef,
    }) as { threads: Array<{ threadRef: string }> };
    const stack = await harness.dispatcher.call("unity_debug_stack_trace", {
      sessionRef: harness.selection.sessionRef,
      threadRef: threads.threads[0].threadRef,
    }) as { frames: Array<{ frameRef: string }> };
    harness.customRequest.mockClear();

    await expect(harness.dispatcher.call("unity_debug_evaluate_safe", {
      sessionRef: harness.selection.sessionRef,
      frameRef: stack.frames[0].frameRef,
      expression: "x".repeat(4_096),
    })).resolves.toMatchObject({
      sessionRef: harness.selection.sessionRef,
      state: "stopped",
      stopGeneration: 3,
      eventSequence: 11,
      result: "100",
    });
    expect(harness.customRequest).toHaveBeenLastCalledWith("evaluate", {
      frameId: 401,
      expression: "x".repeat(4_096),
      context: "hover",
    });

    for (const input of [
      { frameRef: stack.frames[0].frameRef, expression: "ApplyDamage()" },
      { frameRef: stack.frames[0].frameRef, expression: "ApplyDamage()", allowSideEffects: false },
    ]) {
      await expect(harness.dispatcher.call("unity_debug_evaluate_explicit", {
        sessionRef: harness.selection.sessionRef,
        ...input,
      })).rejects.toMatchObject({ code: "SIDE_EFFECTS_NOT_ALLOWED" });
    }
    await expect(harness.dispatcher.call("unity_debug_evaluate_explicit", {
      sessionRef: harness.selection.sessionRef,
      frameRef: stack.frames[0].frameRef,
      expression: "ApplyDamage()",
      allowSideEffects: true,
    })).resolves.toMatchObject({
      sessionRef: harness.selection.sessionRef,
      state: "stopped",
      stopGeneration: 3,
      eventSequence: 11,
      result: "100",
    });
    expect(harness.customRequest).toHaveBeenLastCalledWith("evaluate", {
      frameId: 401,
      expression: "ApplyDamage()",
      context: "repl",
    });

    await expect(harness.dispatcher.call("unity_debug_evaluate_safe", {
      sessionRef: harness.selection.sessionRef,
      frameRef: stack.frames[0].frameRef,
      expression: "x".repeat(4_097),
    })).rejects.toMatchObject({ code: "DAP_FAILURE" });
  });

  it("truncates display strings at 4096 UTF-16 units without splitting surrogates", async () => {
    const tooLong = `${"x".repeat(4_095)}😀tail`;
    const harness = debugHarness({
      customRequest: async (command) => command === "variables"
        ? { variables: [{ name: "value", value: tooLong, variablesReference: 0 }] }
        : command === "evaluate"
        ? { result: tooLong, variablesReference: 0 }
        : defaultDapResponse(command),
    });
    const snapshot = await harness.dispatcher.call("unity_debug_snapshot", {
      sessionRef: harness.selection.sessionRef,
    }) as { frames: Array<{ frameRef: string }>; variables: Array<{ value: string; truncated?: boolean }> };
    const evaluation = await harness.dispatcher.call("unity_debug_evaluate_safe", {
      sessionRef: harness.selection.sessionRef,
      frameRef: snapshot.frames[0].frameRef,
      expression: "value",
    }) as { result: string; truncated?: boolean };

    expect(snapshot.variables[0].value.length).toBeLessThanOrEqual(4_096);
    expect(snapshot.variables[0].value.endsWith("\ud83d")).toBe(false);
    expect(snapshot.variables[0].truncated).toBe(true);
    expect(evaluation.result.length).toBeLessThanOrEqual(4_096);
    expect(evaluation.result.endsWith("\ud83d")).toBe(false);
    expect(evaluation.truncated).toBe(true);
  });

  it("marks truncation when only sourceName or type fields exceed the display bound", async () => {
    const tooLong = `${"t".repeat(4_095)}😀tail`;
    const harness = debugHarness({
      customRequest: async (command) => command === "stackTrace"
        ? { stackFrames: [{
          id: 401,
          name: "Update",
          line: 1,
          column: 1,
          source: { name: tooLong },
        }] }
        : command === "variables"
        ? { variables: [{
          name: "value",
          value: "short",
          type: tooLong,
          variablesReference: 0,
        }] }
        : command === "evaluate"
        ? { result: "short", type: tooLong, variablesReference: 0 }
        : defaultDapResponse(command),
    });
    const snapshot = await harness.dispatcher.call("unity_debug_snapshot", {
      sessionRef: harness.selection.sessionRef,
    }) as {
      frames: Array<{ frameRef: string; sourceName: string; truncated?: boolean }>;
      variables: Array<{ type: string; truncated?: boolean }>;
    };
    const evaluation = await harness.dispatcher.call("unity_debug_evaluate_safe", {
      sessionRef: harness.selection.sessionRef,
      frameRef: snapshot.frames[0].frameRef,
      expression: "value",
    }) as { type: string; truncated?: boolean };

    expect(snapshot.frames[0]).toMatchObject({ truncated: true });
    expect(snapshot.frames[0].sourceName.length).toBeLessThanOrEqual(4_096);
    expect(snapshot.frames[0].sourceName.endsWith("\ud83d")).toBe(false);
    expect(snapshot.variables[0]).toMatchObject({ truncated: true });
    expect(snapshot.variables[0].type.endsWith("\ud83d")).toBe(false);
    expect(evaluation).toMatchObject({ truncated: true });
    expect(evaluation.type.endsWith("\ud83d")).toBe(false);
  });

  it("publishes only a stable variables prefix within the shared UTF-8 result budget", async () => {
    const escapedMultibyte = "\u0001汉".repeat(2_048);
    const harness = debugHarness({
      customRequest: async (command) => command === "variables"
        ? {
            variables: Array.from({ length: 100 }, (_, index) => ({
              name: `value-${index}`,
              value: escapedMultibyte,
              type: escapedMultibyte,
              variablesReference: 1_000 + index,
            })),
          }
        : defaultDapResponse(command),
    });

    const snapshot = await harness.dispatcher.call("unity_debug_snapshot", {
      sessionRef: harness.selection.sessionRef,
    }) as {
      truncated?: true;
      variables: Array<{ name: string; variablesRef?: string }>;
    };

    expect(Buffer.byteLength(JSON.stringify(snapshot), "utf8")).toBeLessThanOrEqual(786_432);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.variables.length).toBeGreaterThan(0);
    expect(snapshot.variables.length).toBeLessThan(100);
    expect(snapshot.variables.map(({ name }) => name)).toEqual(
      Array.from({ length: snapshot.variables.length }, (_, index) => `value-${index}`),
    );
    expect(harness.references.activeReferenceCount).toBe(countPublishedReferences(snapshot));
  });
});

function countPublishedReferences(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((count, entry) => count + countPublishedReferences(entry), 0);
  }
  if (typeof value !== "object" || value === null) {
    return 0;
  }
  return Object.entries(value).reduce(
    (count, [key, entry]) => count + (
      key === "threadRef" || key === "frameRef" || key === "variablesRef"
        ? 1
        : countPublishedReferences(entry)
    ),
    0,
  );
}
