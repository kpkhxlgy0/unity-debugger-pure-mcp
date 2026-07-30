import path from "node:path";
import { vi } from "vitest";
import type * as vscode from "vscode";

import { SessionCommandQueue } from "../../mcp-extension/src/debug/commandQueue.js";
import { EventBuffer } from "../../mcp-extension/src/debug/eventBuffer.js";
import { ReferenceStore } from "../../mcp-extension/src/debug/referenceStore.js";
import { SessionRegistry } from "../../mcp-extension/src/debug/sessionRegistry.js";
import {
  EventSequencer,
  type DebugSessionState,
} from "../../mcp-extension/src/debug/stateProjector.js";
import { ToolDispatcher } from "../../mcp-extension/src/tools/toolDispatcher.js";

export const workspaceRoot = "H:\\workspace\\MyGame";

export class CountingQueue extends SessionCommandQueue {
  public reads = 0;
  public writes = 0;

  public override read<T>(sessionId: string, operation: () => T | PromiseLike<T>): Promise<T> {
    this.reads += 1;
    return super.read(sessionId, operation);
  }

  public override write<T>(sessionId: string, operation: () => T | PromiseLike<T>): Promise<T> {
    this.writes += 1;
    return super.write(sessionId, operation);
  }
}

export function makeDebugSession(
  id: string,
  customRequest: (command: string, body?: unknown) => PromiseLike<unknown>,
): vscode.DebugSession {
  return {
    id,
    type: "unity-debugger-pure",
    name: "Unity",
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

export function defaultDapResponse(command: string): unknown {
  switch (command) {
    case "threads":
      return { threads: [{ id: 71, name: "Main Thread" }, { id: 72, name: "Worker" }] };
    case "stackTrace":
      return {
        stackFrames: [
          { id: 401, name: "Update", line: 12, column: 3, source: { name: "Player.cs", path: `${workspaceRoot}\\Player.cs` } },
          { id: 402, name: "Loop", line: 44, column: 1 },
        ],
        totalFrames: 2,
      };
    case "scopes":
      return {
        scopes: [
          { name: "Expensive", variablesReference: 501, expensive: true },
          { name: "Locals", variablesReference: 502, expensive: false },
        ],
      };
    case "variables":
      return {
        variables: [
          { name: "health", value: "100", type: "int", variablesReference: 0 },
          { name: "player", value: "Player", type: "Player", variablesReference: 601 },
        ],
      };
    case "evaluate":
      return { result: "100", type: "int", variablesReference: 0 };
    default:
      return {};
  }
}

interface HarnessOptions {
  readonly queue?: CountingQueue;
  readonly customRequest?: (command: string, body?: unknown) => PromiseLike<unknown>;
  readonly trusted?: boolean;
}

export function debugHarness(options: HarnessOptions = {}) {
  let trusted = options.trusted ?? true;
  let sessionEntropy = 7;
  const sessions = new SessionRegistry(() => Buffer.alloc(16, sessionEntropy++));
  const references = new ReferenceStore(() => Buffer.alloc(32, 8));
  const queue = options.queue ?? new CountingQueue();
  const states = new Map<string, DebugSessionState>();
  const eventBuffers = new Map<string, EventBuffer>();
  const customRequest = vi.fn(options.customRequest ?? (async (command: string) => defaultDapResponse(command)));
  const session = makeDebugSession("raw-session-id", customRequest);
  const selection = sessions.register(session, true)!;
  states.set(session.id, Object.freeze({
    phase: "stopped",
    stopGeneration: 3,
    eventSequence: 11,
    reason: "breakpoint",
    threadId: 71,
  }));
  eventBuffers.set(selection.sessionRef, new EventBuffer(new EventSequencer()));
  const dispatcher = new ToolDispatcher({
    dependency: {
      discoverTargets: vi.fn(async () => []),
      startAttach: vi.fn(async () => ({ sessionId: "unused", targetId: "unused" })),
    },
    sessions,
    queue,
    breakpoints: {
      list: vi.fn(() => []),
      add: vi.fn(() => ({ breakpointRef: "unused", sourcePath: "unused", line: 1, verified: false })),
      remove: vi.fn(),
    },
    workspace: {
      isTrusted: () => trusted,
      roots: () => [workspaceRoot],
    },
    debug: { stopDebugging: vi.fn(async () => undefined) },
    stateForSession: (candidate) => states.get(candidate.id),
    references,
    eventsForSession: (sessionRef) => eventBuffers.get(sessionRef),
  });
  return {
    dispatcher,
    sessions,
    references,
    queue,
    states,
    eventBuffers,
    session,
    selection,
    customRequest,
    setTrusted(value: boolean) {
      trusted = value;
    },
  };
}

export function assertNoRawDapHandleKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) assertNoRawDapHandleKeys(entry);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, entry] of Object.entries(value)) {
    if (["id", "threadId", "frameId", "variablesReference"].includes(key)) {
      throw new Error(`raw DAP handle key escaped: ${key}`);
    }
    assertNoRawDapHandleKeys(entry);
  }
}
