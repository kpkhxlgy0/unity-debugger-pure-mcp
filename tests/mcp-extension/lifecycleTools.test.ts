import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";

import { SessionCommandQueue } from "../../mcp-extension/src/debug/commandQueue.js";
import { SessionRegistry } from "../../mcp-extension/src/debug/sessionRegistry.js";
import type { DebugSessionState } from "../../mcp-extension/src/debug/stateProjector.js";
import type { PublicEditorTarget } from "../../mcp-extension/src/dependencyAdapter.js";
import { ToolDispatcher } from "../../mcp-extension/src/tools/toolDispatcher.js";

const firstRoot = "H:\\workspace\\MyGame";
const secondRoot = "H:\\workspace\\OtherGame";

const firstTarget: PublicEditorTarget = Object.freeze({
  targetId: "target-1",
  processId: 4312,
  projectName: "MyGame",
  workspaceRoot: firstRoot,
  projectVersion: "2022.3.50f1",
  source: "advertisement",
});

function debugSession(
  id: string,
  workspaceRoot = firstRoot,
  customRequest: (command: string, args?: unknown) => PromiseLike<unknown> =
    vi.fn(async () => ({})),
): vscode.DebugSession {
  return {
    id,
    type: "unity-debugger-pure",
    name: "Attach to Unity Debugger Pure",
    workspaceFolder: {
      index: 0,
      name: path.win32.basename(workspaceRoot),
      uri: { fsPath: workspaceRoot },
    },
    configuration: {},
    customRequest,
    getDebugProtocolBreakpoint: vi.fn(),
  } as unknown as vscode.DebugSession;
}

function state(
  phase: DebugSessionState["phase"] = "running",
  eventSequence = 0,
): DebugSessionState {
  return Object.freeze({ phase, stopGeneration: 0, eventSequence });
}

interface HarnessOptions {
  readonly trusted?: boolean;
  readonly targets?: readonly PublicEditorTarget[];
  readonly roots?: readonly string[];
  readonly stateForSession?: (
    session: vscode.DebugSession,
  ) => DebugSessionState | undefined;
}

function harness(options: HarnessOptions = {}) {
  let now = 1_000;
  let currentRoots = options.roots ?? [firstRoot, `${firstRoot}\\.`, secondRoot];
  let entropy = 1;
  const sessions = new SessionRegistry(() => Buffer.alloc(16, entropy++));
  const states = new Map<string, DebugSessionState>();
  const discoverTargets = vi.fn(async () => options.targets ?? [firstTarget]);
  const startAttach = vi.fn(async (targetId: string) => {
    const session = debugSession(`started-${targetId}`);
    sessions.register(session, true);
    states.set(session.id, state("starting"));
    return { sessionId: session.id, targetId };
  });
  const stopDebugging = vi.fn(async () => undefined);
  const breakpointRegistry = {
    list: vi.fn(() => []),
    add: vi.fn(() => ({ breakpointRef: "breakpoint-1" })),
    remove: vi.fn(),
  };
  const dispatcher = new ToolDispatcher({
    dependency: { discoverTargets, startAttach },
    sessions,
    queue: new SessionCommandQueue(),
    breakpoints: breakpointRegistry,
    workspace: {
      isTrusted: () => options.trusted ?? true,
      roots: () => currentRoots,
    },
    debug: { stopDebugging },
    stateForSession: options.stateForSession ?? ((session) => states.get(session.id)),
    now: () => now,
  });
  return {
    dispatcher,
    sessions,
    states,
    discoverTargets,
    startAttach,
    stopDebugging,
    breakpointRegistry,
    advanceTime(milliseconds: number) {
      now += milliseconds;
    },
    setRoots(roots: readonly string[]) {
      currentRoots = roots;
    },
  };
}

async function listTargets(dispatcher: ToolDispatcher, clientId = "client-1") {
  return dispatcher.call("unity_debug_list_targets", {}, clientId);
}

describe("ToolDispatcher lifecycle tools", () => {
  it("reports normalized not-attached status without throwing", async () => {
    const { dispatcher } = harness();

    await expect(dispatcher.call("unity_debug_status", {})).resolves.toEqual({
      session: null,
      state: "not-attached",
      eventSequence: 0,
    });
  });

  it("checks workspace trust before discovery or debugger side effects", async () => {
    const { dispatcher, discoverTargets, stopDebugging } = harness({ trusted: false });
    const expected = {
      code: "WORKSPACE_UNTRUSTED",
      message: "Trust this workspace before controlling the debugger.",
      retryable: false,
      currentState: "not-attached",
      action: "Use Workspace: Manage Workspace Trust, then retry.",
    };

    await expect(
      dispatcher.call("unity_debug_list_targets", { workspaceRoots: ["C:\\secret"] } as never),
    ).rejects.toEqual(expected);
    await expect(
      dispatcher.call("unity_debug_disconnect", {
        sessionRef: "forged",
        terminateSession: true,
      }),
    ).rejects.toEqual(expected);
    expect(discoverTargets).not.toHaveBeenCalled();
    expect(stopDebugging).not.toHaveBeenCalled();
  });

  it("discovers only canonical current VS Code workspace roots", async () => {
    const { dispatcher, discoverTargets } = harness();

    await expect(listTargets(dispatcher)).resolves.toEqual({ targets: [firstTarget] });

    expect(discoverTargets).toHaveBeenCalledWith([firstRoot, secondRoot]);
  });

  it("reuses exactly one matching live tracked session", async () => {
    const { dispatcher, sessions, states, startAttach } = harness();
    const live = debugSession("live-session");
    const selection = sessions.register(live, true)!;
    states.set(live.id, state("stopped", 12));
    await listTargets(dispatcher);

    await expect(
      dispatcher.call("unity_debug_attach", { targetId: firstTarget.targetId }, "client-1"),
    ).resolves.toEqual({
      session: selection,
      state: "stopped",
      stopGeneration: 0,
      eventSequence: 12,
      reused: true,
    });
    expect(startAttach).not.toHaveBeenCalled();
  });

  it("ignores tracked sessions from other roots when choosing a reusable session", async () => {
    const { dispatcher, sessions, states, startAttach } = harness();
    const other = debugSession("other-session", secondRoot);
    const matching = debugSession("matching-session", firstRoot);
    sessions.register(other, true);
    const expected = sessions.register(matching, true)!;
    states.set(matching.id, state("running", 3));
    await listTargets(dispatcher);

    await expect(
      dispatcher.call("unity_debug_attach", { targetId: firstTarget.targetId }, "client-1"),
    ).resolves.toMatchObject({ session: expected, reused: true });
    expect(startAttach).not.toHaveBeenCalled();
  });

  it("consumes a listed target capability on the first attach attempt", async () => {
    const { dispatcher, sessions, startAttach } = harness();
    sessions.register(debugSession("live-session"), true);
    await listTargets(dispatcher);
    await dispatcher.call(
      "unity_debug_attach",
      { targetId: firstTarget.targetId },
      "client-1",
    );

    await expect(
      dispatcher.call("unity_debug_attach", { targetId: firstTarget.targetId }, "client-1"),
    ).rejects.toMatchObject({ code: "NO_TARGET" });
    expect(startAttach).not.toHaveBeenCalled();
  });

  it("expires a target capability after the base API's 60 second lifetime", async () => {
    const { dispatcher, sessions, startAttach, advanceTime } = harness();
    sessions.register(debugSession("live-session"), true);
    await listTargets(dispatcher);
    advanceTime(60_000);

    await expect(
      dispatcher.call("unity_debug_attach", { targetId: firstTarget.targetId }, "client-1"),
    ).rejects.toMatchObject({ code: "NO_TARGET" });
    expect(startAttach).not.toHaveBeenCalled();
  });

  it("revalidates the target root against current workspace folders at attach time", async () => {
    const { dispatcher, sessions, startAttach, setRoots } = harness();
    sessions.register(debugSession("live-session"), true);
    await listTargets(dispatcher);
    setRoots([secondRoot]);

    await expect(
      dispatcher.call("unity_debug_attach", { targetId: firstTarget.targetId }, "client-1"),
    ).rejects.toMatchObject({ code: "WORKSPACE_NOT_ALLOWED" });
    expect(startAttach).not.toHaveBeenCalled();
  });

  it("does not repopulate target capabilities when disconnect races discovery", async () => {
    let finishDiscovery!: (targets: readonly PublicEditorTarget[]) => void;
    const { dispatcher, discoverTargets, startAttach } = harness();
    discoverTargets.mockImplementationOnce(async () =>
      new Promise<readonly PublicEditorTarget[]>((resolve) => {
        finishDiscovery = resolve;
      })
    );
    const listing = listTargets(dispatcher);
    await Promise.resolve();

    dispatcher.onDisconnect("client-1");
    finishDiscovery([firstTarget]);

    await expect(listing).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(
      dispatcher.call("unity_debug_attach", { targetId: firstTarget.targetId }, "client-1"),
    ).rejects.toMatchObject({ code: "NO_TARGET" });
    expect(startAttach).not.toHaveBeenCalled();
  });

  it("does not restore a client selection when disconnect races API attach", async () => {
    let finishAttach!: (started: { sessionId: string; targetId: string }) => void;
    const { dispatcher, sessions, startAttach } = harness();
    await listTargets(dispatcher);
    startAttach.mockImplementationOnce(async () =>
      new Promise<{ sessionId: string; targetId: string }>((resolve) => {
        finishAttach = resolve;
      })
    );
    const attaching = dispatcher.call(
      "unity_debug_attach",
      { targetId: firstTarget.targetId },
      "client-1",
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(startAttach).toHaveBeenCalledOnce();

    dispatcher.onDisconnect("client-1");
    const startedSession = debugSession("started-after-disconnect");
    sessions.register(startedSession, true);
    finishAttach({
      sessionId: startedSession.id,
      targetId: firstTarget.targetId,
    });

    await expect(attaching).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(dispatcher.call("unity_debug_status", {}, "client-1")).resolves.toEqual({
      session: null,
      state: "not-attached",
      eventSequence: 0,
    });
  });

  it("invalidates earlier capabilities before awaiting a failed target refresh", async () => {
    const { dispatcher, discoverTargets, startAttach } = harness();
    await listTargets(dispatcher);
    discoverTargets.mockRejectedValueOnce(new Error("private discovery failure"));

    await expect(listTargets(dispatcher)).rejects.toMatchObject({ code: "DAP_FAILURE" });
    await expect(
      dispatcher.call("unity_debug_attach", { targetId: firstTarget.targetId }, "client-1"),
    ).rejects.toMatchObject({ code: "NO_TARGET" });
    expect(startAttach).not.toHaveBeenCalled();
  });

  it("starts attach through the public dependency and resolves the exact registered session", async () => {
    const { dispatcher, startAttach } = harness();
    await listTargets(dispatcher);

    const result = await dispatcher.call(
      "unity_debug_attach",
      { targetId: firstTarget.targetId },
      "client-1",
    );

    expect(startAttach).toHaveBeenCalledWith(firstTarget.targetId);
    expect(result).toMatchObject({
      session: { tracked: true },
      state: "starting",
      eventSequence: 0,
      reused: false,
    });
  });

  it("does not trust a target ID listed by another authenticated client", async () => {
    const { dispatcher, startAttach } = harness();
    await listTargets(dispatcher, "client-1");

    await expect(
      dispatcher.call("unity_debug_attach", { targetId: firstTarget.targetId }, "client-2"),
    ).rejects.toEqual({
      code: "NO_TARGET",
      message: "No matching Unity debugger target is available.",
      retryable: true,
      currentState: "target_unavailable",
      action: "List debugger targets again and retry with a returned target reference.",
    });
    expect(startAttach).not.toHaveBeenCalled();
  });

  it("does not reuse untracked or ambiguous matching sessions", async () => {
    const untrackedHarness = harness();
    untrackedHarness.sessions.register(debugSession("untracked"), false);
    await listTargets(untrackedHarness.dispatcher);
    await untrackedHarness.dispatcher.call(
      "unity_debug_attach",
      { targetId: firstTarget.targetId },
      "client-1",
    );
    expect(untrackedHarness.startAttach).toHaveBeenCalledOnce();

    const ambiguousHarness = harness();
    ambiguousHarness.sessions.register(debugSession("tracked-a"), true);
    ambiguousHarness.sessions.register(debugSession("tracked-b"), true);
    await listTargets(ambiguousHarness.dispatcher);
    await expect(
      ambiguousHarness.dispatcher.call(
        "unity_debug_attach",
        { targetId: firstTarget.targetId },
        "client-1",
      ),
    ).rejects.toMatchObject({ code: "AMBIGUOUS_TARGET" });
    expect(ambiguousHarness.startAttach).not.toHaveBeenCalled();
  });

  it("default disconnect releases only the caller selection and preserves VS Code", async () => {
    const { dispatcher, sessions, stopDebugging } = harness();
    const live = debugSession("live-session");
    sessions.register(live, true);
    await listTargets(dispatcher);
    const attached = await dispatcher.call(
      "unity_debug_attach",
      { targetId: firstTarget.targetId },
      "client-1",
    ) as { session: { sessionRef: string } };

    await expect(
      dispatcher.call("unity_debug_disconnect", {}, "client-1"),
    ).resolves.toEqual({
      sessionRef: attached.session.sessionRef,
      terminated: false,
    });
    expect(stopDebugging).not.toHaveBeenCalled();
    expect(sessions.resolveDebugSession(sessions.select(attached.session.sessionRef))).toBe(live);
    await expect(dispatcher.call("unity_debug_status", {}, "client-1")).resolves.toEqual({
      session: null,
      state: "not-attached",
      eventSequence: 0,
    });
  });

  it("explicit termination passes the full live vscode.DebugSession", async () => {
    const { dispatcher, sessions, stopDebugging } = harness();
    const live = debugSession("live-session");
    const selection = sessions.register(live, true)!;

    await expect(
      dispatcher.call("unity_debug_disconnect", {
        sessionRef: selection.sessionRef,
        terminateSession: true,
      }, "client-1"),
    ).resolves.toEqual({
      sessionRef: selection.sessionRef,
      terminated: true,
    });
    expect(stopDebugging).toHaveBeenCalledWith(live);
  });

  it("clears selections and target capabilities on bridge disconnect", async () => {
    const { dispatcher, sessions, startAttach } = harness();
    sessions.register(debugSession("live-session"), true);
    await listTargets(dispatcher);
    await dispatcher.call(
      "unity_debug_attach",
      { targetId: firstTarget.targetId },
      "client-1",
    );

    dispatcher.onDisconnect("client-1");

    await expect(dispatcher.call("unity_debug_status", {}, "client-1")).resolves.toEqual({
      session: null,
      state: "not-attached",
      eventSequence: 0,
    });
    await expect(
      dispatcher.call("unity_debug_attach", { targetId: firstTarget.targetId }, "client-1"),
    ).rejects.toMatchObject({ code: "NO_TARGET" });
    expect(startAttach).not.toHaveBeenCalled();
  });

  it("revalidates cached selections against the live registry", async () => {
    const { dispatcher, sessions, stopDebugging } = harness();
    const live = debugSession("live-session");
    const selection = sessions.register(live, true)!;
    await listTargets(dispatcher);
    await dispatcher.call(
      "unity_debug_attach",
      { targetId: firstTarget.targetId },
      "client-1",
    );
    sessions.remove(live);

    await expect(dispatcher.call("unity_debug_status", {}, "client-1")).resolves.toEqual({
      session: null,
      state: "not-attached",
      eventSequence: 0,
    });
    await expect(
      dispatcher.call("unity_debug_disconnect", {
        sessionRef: selection.sessionRef,
        terminateSession: true,
      }, "client-1"),
    ).rejects.toMatchObject({ code: "NOT_ATTACHED" });
    expect(stopDebugging).not.toHaveBeenCalled();
  });

  it("does not hide state projection failures as a detached session", async () => {
    let failState = false;
    const stateHarness = harness({
      stateForSession: () => {
        if (failState) {
          throw new Error("private state projection failure");
        }
        return state("running", 4);
      },
    });
    stateHarness.sessions.register(debugSession("live-session"), true);
    await listTargets(stateHarness.dispatcher);
    await stateHarness.dispatcher.call(
      "unity_debug_attach",
      { targetId: firstTarget.targetId },
      "client-1",
    );
    failState = true;

    await expect(
      stateHarness.dispatcher.call("unity_debug_status", {}, "client-1"),
    ).rejects.toEqual({
      code: "DAP_FAILURE",
      message: "The debugger request failed.",
      retryable: false,
      currentState: "unknown",
      action: "Check debugger status before retrying the request.",
    });
  });

  it("serializes exception policy changes and forwards only DAP filter modes", async () => {
    let finishFirst!: () => void;
    let active = 0;
    let maximum = 0;
    const requests: Array<{ command: string; args: unknown }> = [];
    const customRequest = vi.fn(async (command: string, args: unknown) => {
      active += 1;
      maximum = Math.max(maximum, active);
      requests.push({ command, args });
      if (requests.length === 1) {
        await new Promise<void>((resolve) => { finishFirst = resolve; });
      }
      active -= 1;
      return {};
    });
    const { dispatcher, sessions } = harness();
    const selection = sessions.register(debugSession("live-session", firstRoot, customRequest), true)!;

    const first = dispatcher.call("unity_debug_set_exception_breakpoints", {
      sessionRef: selection.sessionRef,
      mode: "uncaught",
    }, "client-1");
    const second = dispatcher.call("unity_debug_set_exception_breakpoints", {
      sessionRef: selection.sessionRef,
      mode: "all",
    }, "client-2");
    await Promise.resolve();
    await Promise.resolve();
    expect(requests).toEqual([{
      command: "setExceptionBreakpoints",
      args: { filters: ["uncaught"] },
    }]);
    finishFirst();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { sessionRef: selection.sessionRef, mode: "uncaught" },
      { sessionRef: selection.sessionRef, mode: "all" },
    ]);
    expect(maximum).toBe(1);
    expect(requests[1]).toEqual({
      command: "setExceptionBreakpoints",
      args: { filters: ["all"] },
    });
  });

  it("uses strict bounded schemas and sanitizes validation and debugger failures", async () => {
    const { dispatcher, sessions } = harness();
    const privateCondition = "private condition expression";
    const live = debugSession("live-session", firstRoot, vi.fn(async () => {
      throw new Error("C:\\private\\debugger.log");
    }));
    const selection = sessions.register(live, true)!;

    for (const operation of [
      dispatcher.call("unity_debug_list_targets", { root: "C:\\private" } as never),
      dispatcher.call("unity_debug_add_breakpoint", {
        sourcePath: `${firstRoot}\\Player.cs`,
        line: 0,
        condition: privateCondition,
      }),
      dispatcher.call("unity_debug_add_breakpoint", {
        sourcePath: `${firstRoot}\\Player.cs`,
        line: 1,
        condition: "x".repeat(1_025),
      }),
      dispatcher.call("unity_debug_set_exception_breakpoints", {
        sessionRef: selection.sessionRef,
        mode: "caught",
      } as never),
      dispatcher.call("unity_debug_set_exception_breakpoints", {
        sessionRef: selection.sessionRef,
        mode: "none",
      }),
    ]) {
      const error = await operation.catch((value) => value);
      expect(error).toEqual({
        code: "DAP_FAILURE",
        message: "The debugger request failed.",
        retryable: false,
        currentState: "unknown",
        action: "Check debugger status before retrying the request.",
      });
      expect(JSON.stringify(error)).not.toContain(privateCondition);
      expect(JSON.stringify(error)).not.toContain("private\\debugger");
    }
  });
});
