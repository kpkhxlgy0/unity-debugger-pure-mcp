import { describe, expect, it } from "vitest";

import {
  debugHarness,
  defaultDapResponse,
  makeDebugSession,
} from "./debugToolsHarness.js";

describe("ToolDispatcher execution control", () => {
  it("pauses only a running session using an internally selected raw thread", async () => {
    const harness = debugHarness();
    harness.states.set(harness.session.id, Object.freeze({
      phase: "running",
      stopGeneration: 4,
      eventSequence: 12,
    }));

    await expect(harness.dispatcher.call("unity_debug_pause", {
      sessionRef: harness.selection.sessionRef,
    })).resolves.toEqual({
      sessionRef: harness.selection.sessionRef,
      state: "running",
      stopGeneration: 4,
      eventSequence: 12,
      transitioning: true,
    });
    expect(harness.queue.writes).toBe(1);
    expect(harness.customRequest.mock.calls).toEqual([
      ["threads", {}],
      ["pause", { threadId: 71 }],
    ]);
    expect(JSON.stringify(await harness.dispatcher.call("unity_debug_status", {
      sessionRef: harness.selection.sessionRef,
    }))).not.toContain("71");
  });

  it("invalidates references before continue and blocks inspection until an observed transition", async () => {
    let release!: (value: unknown) => void;
    const harness = debugHarness({
      customRequest: async (command) => command === "continue"
        ? new Promise((resolve) => { release = resolve; })
        : defaultDapResponse(command),
    });
    const threads = await harness.dispatcher.call("unity_debug_threads", {
      sessionRef: harness.selection.sessionRef,
    }) as { threads: Array<{ threadRef: string }> };
    const continuing = harness.dispatcher.call("unity_debug_continue", {
      sessionRef: harness.selection.sessionRef,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.references.activeReferenceCount).toBe(0);
    expect(harness.customRequest).toHaveBeenLastCalledWith("continue", { threadId: 71 });
    release({});
    await expect(continuing).resolves.toMatchObject({
      sessionRef: harness.selection.sessionRef,
      state: "running",
      stopGeneration: 3,
      eventSequence: 11,
      transitioning: true,
    });

    await expect(harness.dispatcher.call("unity_debug_threads", {
      sessionRef: harness.selection.sessionRef,
    })).rejects.toMatchObject({ code: "NOT_STOPPED" });
    await expect(harness.dispatcher.call("unity_debug_stack_trace", {
      sessionRef: harness.selection.sessionRef,
      threadRef: threads.threads[0].threadRef,
    })).rejects.toMatchObject({ code: "NOT_STOPPED" });

    harness.states.set(harness.session.id, Object.freeze({
      phase: "running",
      stopGeneration: 4,
      eventSequence: 12,
    }));
    harness.dispatcher.onSessionStateChanged(harness.selection.sessionRef);
    await expect(harness.dispatcher.call("unity_debug_threads", {
      sessionRef: harness.selection.sessionRef,
    })).rejects.toMatchObject({ code: "NOT_STOPPED" });
  });

  it.each([
    ["in", "stepIn"],
    ["over", "next"],
    ["out", "stepOut"],
  ] as const)("maps step %s to exact DAP %s", async (kind, command) => {
    const harness = debugHarness();

    await expect(harness.dispatcher.call("unity_debug_step", {
      sessionRef: harness.selection.sessionRef,
      kind,
    })).resolves.toMatchObject({
      sessionRef: harness.selection.sessionRef,
      state: "running",
      stopGeneration: 3,
      eventSequence: 11,
      transitioning: true,
      kind,
    });
    expect(harness.customRequest).toHaveBeenLastCalledWith(command, { threadId: 71 });
  });

  it("clears a failed control transition while keeping old refs stale", async () => {
    let failContinue = true;
    const harness = debugHarness({
      customRequest: async (command) => {
        if (command === "continue" && failContinue) {
          failContinue = false;
          throw new Error("private adapter detail");
        }
        return defaultDapResponse(command);
      },
    });
    const before = await harness.dispatcher.call("unity_debug_threads", {
      sessionRef: harness.selection.sessionRef,
    }) as { threads: Array<{ threadRef: string }> };

    await expect(harness.dispatcher.call("unity_debug_continue", {
      sessionRef: harness.selection.sessionRef,
    })).rejects.toMatchObject({ code: "DAP_FAILURE" });
    const after = await harness.dispatcher.call("unity_debug_threads", {
      sessionRef: harness.selection.sessionRef,
    }) as { threads: Array<{ threadRef: string }> };
    expect(after.threads).toHaveLength(2);
    await expect(harness.dispatcher.call("unity_debug_stack_trace", {
      sessionRef: harness.selection.sessionRef,
      threadRef: before.threads[0].threadRef,
    })).rejects.toMatchObject({ code: "STALE_REFERENCE" });
  });

  it("prevents duplicate controls while the first transition awaits an observed event", async () => {
    const harness = debugHarness();
    await harness.dispatcher.call("unity_debug_continue", {
      sessionRef: harness.selection.sessionRef,
    }, "client-1");

    await expect(harness.dispatcher.call("unity_debug_continue", {
      sessionRef: harness.selection.sessionRef,
    }, "client-2")).rejects.toMatchObject({ code: "NOT_STOPPED" });
    expect(harness.customRequest.mock.calls.filter(([command]) => command === "continue")).toHaveLength(1);
  });

  it("reports fresh projector metadata and clears transitioning when a control event was observed", async () => {
    let observeControl = () => undefined;
    const harness = debugHarness({
      customRequest: async (command) => {
        if (command === "continue") {
          observeControl();
          return { allThreadsContinued: true };
        }
        return defaultDapResponse(command);
      },
    });
    observeControl = () => {
      harness.states.set(harness.session.id, Object.freeze({
        phase: "running",
        stopGeneration: 4,
        eventSequence: 12,
      }));
    };

    await expect(harness.dispatcher.call("unity_debug_continue", {
      sessionRef: harness.selection.sessionRef,
    })).resolves.toEqual({
      sessionRef: harness.selection.sessionRef,
      state: "running",
      stopGeneration: 4,
      eventSequence: 12,
      transitioning: false,
    });
  });

  it("does not report control success when the session is removed during customRequest", async () => {
    let release!: (value: unknown) => void;
    const harness = debugHarness({
      customRequest: async (command) => command === "continue"
        ? new Promise((resolve) => { release = resolve; })
        : defaultDapResponse(command),
    });
    const pending = harness.dispatcher.call("unity_debug_continue", {
      sessionRef: harness.selection.sessionRef,
    });
    await Promise.resolve();
    await Promise.resolve();
    harness.sessions.remove(harness.session);
    release({ allThreadsContinued: true });

    await expect(pending).rejects.toMatchObject({ code: "NOT_ATTACHED" });
    expect(harness.references.activeReferenceCount).toBe(0);
  });

  it("rejects a replacement DebugSession object after a pending pause succeeds", async () => {
    let release!: (value: unknown) => void;
    const harness = debugHarness({
      customRequest: async (command) => command === "pause"
        ? new Promise((resolve) => { release = resolve; })
        : defaultDapResponse(command),
    });
    harness.states.set(harness.session.id, Object.freeze({
      phase: "running",
      stopGeneration: 4,
      eventSequence: 12,
    }));
    const pending = harness.dispatcher.call("unity_debug_pause", {
      sessionRef: harness.selection.sessionRef,
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const replacement = makeDebugSession(harness.session.id, async () => ({}));
    harness.sessions.register(replacement, true);
    harness.states.set(replacement.id, Object.freeze({
      phase: "running",
      stopGeneration: 4,
      eventSequence: 12,
    }));
    release(undefined);

    await expect(pending).rejects.toMatchObject({ code: "STALE_REFERENCE" });
    expect(harness.references.activeReferenceCount).toBe(0);
  });

  it("cancels queued controls on abort, disconnect, or trust revocation before DAP", async () => {
    for (const cancel of ["abort", "disconnect", "trust"] as const) {
      const harness = debugHarness();
      let release!: () => void;
      const blocker = harness.queue.write(harness.selection.sessionRef, async () =>
        new Promise<void>((resolve) => { release = resolve; })
      );
      await Promise.resolve();
      const controller = new AbortController();
      const control = harness.dispatcher.call("unity_debug_continue", {
        sessionRef: harness.selection.sessionRef,
      }, "queued-client", controller.signal);
      if (cancel === "abort") controller.abort();
      if (cancel === "disconnect") harness.dispatcher.onDisconnect("queued-client");
      if (cancel === "trust") harness.setTrusted(false);
      release();
      await blocker;

      await expect(control).rejects.toMatchObject({
        code: cancel === "trust" ? "WORKSPACE_UNTRUSTED" : "CANCELLED",
      });
      expect(harness.customRequest).not.toHaveBeenCalled();
    }
  });
});
