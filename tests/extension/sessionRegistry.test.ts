import { describe, expect, it } from "vitest";
import type * as vscode from "vscode";

import { SessionRegistry } from "../../src/debug/sessionRegistry.js";

function session(id: string, type = "unity-debugger-pure"): vscode.DebugSession {
  return Object.freeze({
    id,
    type,
    name: `Debug ${id}`,
    workspaceFolder: undefined,
    configuration: {
      name: `Debug ${id}`,
      type,
      request: "attach",
    },
    customRequest: async () => undefined,
    getDebugProtocolBreakpoint: async () => undefined,
  });
}

describe("SessionRegistry", () => {
  it("registers only the exact debugger type using an opaque 128-bit reference", () => {
    const registry = new SessionRegistry(() => Buffer.alloc(16, 0xa5));

    expect(registry.register(session("ignored", "Unity-Debugger-Pure"), true)).toBeUndefined();
    const registered = registry.register(session("raw-vscode-session-id"), true);

    expect(registered).toEqual({
      sessionRef: "paWlpaWlpaWlpaWlpaWlpQ",
      tracked: true,
    });
    expect(registered?.sessionRef).not.toContain("raw-vscode-session-id");
    expect(Buffer.from(registered!.sessionRef, "base64url")).toHaveLength(16);
    expect(JSON.stringify(registered)).not.toContain("raw-vscode-session-id");
  });

  it("keeps duplicate registration stable and allows tracked to become true but not regress", () => {
    let randomCalls = 0;
    const registry = new SessionRegistry(() => {
      randomCalls += 1;
      return Buffer.alloc(16, randomCalls);
    });
    const debugSession = session("session-1");

    const untracked = registry.register(debugSession, false);
    const tracked = registry.register(debugSession, true);
    const notRegressed = registry.register(debugSession, false);

    expect(tracked).toEqual({ sessionRef: untracked?.sessionRef, tracked: true });
    expect(notRegressed).toEqual(tracked);
    expect(randomCalls).toBe(1);
    expect(registry.resolveDebugSession(tracked!)).toBe(debugSession);
  });

  it("regenerates a colliding reference instead of aliasing sessions", () => {
    const values = [
      Buffer.alloc(16, 1),
      Buffer.alloc(16, 1),
      Buffer.alloc(16, 2),
    ];
    const registry = new SessionRegistry(() => values.shift()!);

    const first = registry.register(session("session-1"), true)!;
    const second = registry.register(session("session-2"), true)!;

    expect(second.sessionRef).not.toBe(first.sessionRef);
    expect(registry.resolveDebugSession(first).id).toBe("session-1");
    expect(registry.resolveDebugSession(second).id).toBe("session-2");
  });

  it("selects the sole session and requires an explicit ref when selection is ambiguous", () => {
    let ordinal = 0;
    const registry = new SessionRegistry(() => Buffer.alloc(16, ++ordinal));
    const first = registry.register(session("session-1"), true)!;

    expect(registry.select()).toEqual(first);
    const second = registry.register(session("session-2"), true)!;
    expect(() => registry.select()).toThrowError(expect.objectContaining({
      code: "AMBIGUOUS_TARGET",
      message: "More than one Unity debugger session is attached.",
    }));
    expect(registry.select(second.sessionRef)).toEqual(second);
  });

  it("returns deterministic NOT_ATTACHED errors for no or unknown sessions", () => {
    const registry = new SessionRegistry();

    expect(() => registry.select()).toThrowError({
      code: "NOT_ATTACHED",
      message: "No matching Unity debugger session is attached.",
      retryable: true,
      currentState: "detached",
      action: "Attach to a debugger target and retry the request.",
    });
    expect(() => registry.select("forged-session-ref")).toThrowError({
      code: "NOT_ATTACHED",
      message: "No matching Unity debugger session is attached.",
      retryable: true,
      currentState: "detached",
      action: "Attach to a debugger target and retry the request.",
    });
  });

  it("reports pre-tracker sessions as untracked until re-registered by the tracker", () => {
    const registry = new SessionRegistry(() => Buffer.alloc(16, 4));
    const debugSession = session("pre-existing-session");
    const initial = registry.register(debugSession, false)!;

    expect(() => registry.selectForInspection(initial.sessionRef)).toThrowError({
      code: "SESSION_UNTRACKED",
      message: "The selected debugger session is not fully tracked.",
      retryable: false,
      currentState: "untracked",
      action: "Restart that debug session before using inspection tools.",
    });

    registry.register(debugSession, true);
    expect(registry.selectForInspection(initial.sessionRef)).toEqual({
      sessionRef: initial.sessionRef,
      tracked: true,
    });
  });

  it("removes the exact session deterministically without leaking its raw id", () => {
    let ordinal = 8;
    const registry = new SessionRegistry(() => Buffer.alloc(16, ordinal++));
    const firstSession = session("private-vscode-id-1");
    const first = registry.register(firstSession, true)!;
    const second = registry.register(session("private-vscode-id-2"), true)!;

    expect(registry.remove(firstSession)).toBe(true);
    expect(registry.remove(firstSession)).toBe(false);
    expect(() => registry.select(first.sessionRef)).toThrowError(
      expect.objectContaining({ code: "NOT_ATTACHED" }),
    );
    expect(registry.select()).toEqual(second);
    expect(Object.isFrozen(second)).toBe(true);
    expect(Object.keys(second)).toEqual(["sessionRef", "tracked"]);
  });

  it("does not let a stale session object remove a newer instance with the same VS Code id", () => {
    const registry = new SessionRegistry(() => Buffer.alloc(16, 9));
    const stale = session("reused-id");
    const replacement = session("reused-id");

    registry.register(stale, false);
    registry.register(replacement, true);

    expect(registry.remove(stale)).toBe(false);
    expect(registry.remove(replacement)).toBe(true);
  });

  it("tombstones every issued ref so a removed selection can never revive", () => {
    const firstBytes = Buffer.alloc(16, 6);
    const secondBytes = Buffer.alloc(16, 7);
    const values = [firstBytes, firstBytes, secondBytes];
    const registry = new SessionRegistry(() => values.shift()!);
    const oldSession = session("old-vscode-session");
    const oldSelection = registry.register(oldSession, true)!;

    registry.remove(oldSession);
    const newSession = session("new-vscode-session");
    const newSelection = registry.register(newSession, true)!;

    expect(newSelection.sessionRef).not.toBe(oldSelection.sessionRef);
    expect(() => registry.select(oldSelection.sessionRef)).toThrowError(
      expect.objectContaining({ code: "NOT_ATTACHED" }),
    );
    expect(() => registry.resolveDebugSession(oldSelection)).toThrowError(
      expect.objectContaining({ code: "NOT_ATTACHED" }),
    );
    const resolved: vscode.DebugSession = registry.resolveDebugSession(newSelection);
    expect(resolved).toBe(newSession);
    expect(typeof resolved.customRequest).toBe("function");
  });
});
