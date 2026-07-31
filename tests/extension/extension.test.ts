import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => {
  class Position {
    public constructor(public readonly line: number, public readonly character: number) {}
  }
  class Location {
    public readonly range: { readonly start: Position; readonly end: Position };
    public constructor(
      public readonly uri: { readonly fsPath: string; readonly scheme: string },
      position: Position,
    ) {
      this.range = { start: position, end: position };
    }
  }
  class Breakpoint {
    public constructor(
      public readonly enabled = true,
      public readonly condition?: string,
    ) {}
  }
  class SourceBreakpoint extends Breakpoint {
    public constructor(
      public readonly location: Location,
      enabled = true,
      condition?: string,
    ) {
      super(enabled, condition);
    }
  }
  class McpStdioServerDefinition {
    public constructor(
      public readonly label: string,
      public command: string,
      public args: string[] = [],
      public env: Record<string, string | number | null> = {},
      public version?: string,
    ) {}
  }
  const debug = {
    breakpoints: [] as unknown[],
    addBreakpoints: vi.fn((items: unknown[]) => {
      debug.breakpoints.push(...items);
    }),
    removeBreakpoints: vi.fn((items: unknown[]) => {
      debug.breakpoints = debug.breakpoints.filter((item) => !items.includes(item));
    }),
  };
  return {
    Position,
    Location,
    Breakpoint,
    SourceBreakpoint,
    McpStdioServerDefinition,
    Uri: { file: (fsPath: string) => ({ fsPath, scheme: "file" }) },
    debug,
  };
});

import type * as vscode from "vscode";

import type {
  BridgeToolHandler,
} from "../../src/bridge/bridgeHost.js";
import {
  activateWithDependencies,
  type ExtensionCompositionBoundary,
  type ExtensionRuntime,
} from "../../src/extension.js";

const DEBUG_TYPE = "unity-debugger-pure";
const WORKSPACE_ROOT = path.resolve(".");
const SOURCE_PATH = path.join(WORKSPACE_ROOT, "package.json");
const PIPE_NAME = "\\\\.\\pipe\\unity-debugger-pure-mcp-extension-fixture";
const TOKEN = Buffer.alloc(32, 0x35).toString("base64url");

interface FakeSession {
  readonly id: string;
  readonly type: string;
  readonly workspaceFolder?: { readonly uri: { readonly fsPath: string } };
  readonly customRequest: ReturnType<typeof vi.fn>;
}

interface ListenerSet {
  start?: (session: vscode.DebugSession) => void;
  terminate?: (session: vscode.DebugSession) => void;
  breakpoints?: (event: vscode.BreakpointsChangeEvent) => void;
  tracker?: vscode.DebugAdapterTrackerFactory;
}

function session(id = "raw-vscode-session", type = DEBUG_TYPE): FakeSession {
  return {
    id,
    type,
    workspaceFolder: { uri: { fsPath: WORKSPACE_ROOT } },
    customRequest: vi.fn(async () => ({})),
  };
}

function harness(options: {
  readonly activeSession?: FakeSession;
  readonly failListen?: boolean;
  readonly failClose?: boolean;
  readonly failPublisherStart?: boolean;
  readonly failPublisherClose?: boolean;
  readonly deferPublisherClose?: boolean;
  readonly failProvider?: boolean;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
} = {}) {
  const log: string[] = [];
  const listeners: ListenerSet = {};
  const subscriptions: vscode.Disposable[] = [];
  let bridgeHandler: BridgeToolHandler | undefined;
  let provider: vscode.McpServerDefinitionProvider | undefined;
  let releasePublisherClose: (() => void) | undefined;
  const publisherCloseGate = new Promise<void>((resolve) => {
    releasePublisherClose = resolve;
  });
  const makeDisposable = (name: string): vscode.Disposable => ({
    dispose: vi.fn(() => log.push(`dispose:${name}`)),
  });
  const api = Object.freeze({
    apiVersion: 1 as const,
    extensionVersion: "0.2.0",
    debugType: "unity-debugger-pure" as const,
    discoverTargets: vi.fn(async () => Object.freeze([Object.freeze({
      targetId: "opaque-target",
      processId: 42,
      projectName: "MyGame",
      workspaceRoot: WORKSPACE_ROOT,
      projectVersion: "2022.3.62f3",
      source: "advertisement" as const,
    })])),
    startAttach: vi.fn(async (targetId: string) => ({
      sessionId: "missing-started-session",
      targetId,
    })),
  });
  const boundary: ExtensionCompositionBoundary = {
    platform: options.platform ?? "win32",
    arch: options.arch ?? "x64",
    hasRequiredCapabilities: () => true,
    getDebuggerExtension: () => ({
      activate: vi.fn(async () => {
        log.push("activate-api");
        return api;
      }),
    }),
    isWorkspaceTrusted: () => true,
    workspaceRoots: () => [WORKSPACE_ROOT],
    stopDebugging: vi.fn(async () => undefined),
    activeDebugSession: () => options.activeSession as unknown as vscode.DebugSession,
    onDidStartDebugSession(listener) {
      log.push("register:start");
      listeners.start = listener;
      return makeDisposable("start");
    },
    onDidTerminateDebugSession(listener) {
      log.push("register:terminate");
      listeners.terminate = listener;
      return makeDisposable("terminate");
    },
    onDidChangeBreakpoints(listener) {
      log.push("register:breakpoints");
      listeners.breakpoints = listener;
      return makeDisposable("breakpoints");
    },
    registerDebugAdapterTrackerFactory(type, tracker) {
      log.push(`register:tracker:${type}`);
      listeners.tracker = tracker;
      return makeDisposable("tracker");
    },
    createBridgeHost(handler) {
      bridgeHandler = handler;
      return {
        async listen() {
          log.push("listen");
          if (options.failListen) {
            throw new Error("listen failed");
          }
          return Object.freeze({ protocolVersion: 1 as const, pipeName: PIPE_NAME, token: TOKEN });
        },
        async close() {
          log.push("close:bridge");
          if (options.failClose) {
            throw new Error("close failed");
          }
        },
      };
    },
    async createLiveHostRegistrationPublisher(descriptor) {
      log.push(`create:publisher:${descriptor.pipeName}`);
      return {
        async start() {
          log.push("start:publisher");
          if (options.failPublisherStart) {
            throw new Error("publisher start failed");
          }
        },
        async close() {
          log.push("close:publisher");
          if (options.failPublisherClose) {
            throw new Error("publisher close failed");
          }
          if (options.deferPublisherClose) {
            await publisherCloseGate;
          }
        },
      };
    },
    registerMcpProvider(id, value) {
      log.push(`register:provider:${id}`);
      if (options.failProvider) {
        throw new Error("provider failed");
      }
      provider = value;
      return makeDisposable("provider");
    },
    executable: "D:\\extension\\dist\\mcp-bridge.exe",
    version: "0.1.0",
    statExecutable: async () => ({ isFile: () => true }),
  };
  const context = { subscriptions } as unknown as vscode.ExtensionContext;
  return {
    api,
    boundary,
    bridge: () => bridgeHandler!,
    context,
    listeners,
    log,
    provider: () => provider!,
    releasePublisherClose: () => releasePublisherClose?.(),
    subscriptions,
  };
}

function request(
  handler: BridgeToolHandler,
  name: Parameters<BridgeToolHandler["callTool"]>[0]["name"],
  input: unknown,
  connectionId = "client-one",
  signal = new AbortController().signal,
) {
  return handler.callTool({ connectionId, name, input, signal });
}

describe("MCP companion extension composition", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const vscodeModule = await import("vscode");
    (vscodeModule.debug as unknown as { breakpoints: unknown[] }).breakpoints = [];
  });

  it("activates the debugger before listeners/pipe/provider and owns every resource", async () => {
    const setup = harness();
    const runtime = await activateWithDependencies(setup.context, setup.boundary);

    expect(setup.log).toEqual([
      "activate-api",
      "register:start",
      "register:terminate",
      "register:breakpoints",
      `register:tracker:${DEBUG_TYPE}`,
      "listen",
      `create:publisher:${PIPE_NAME}`,
      "start:publisher",
      "register:provider:unity-debugger-pure-mcp.server",
    ]);
    expect(setup.subscriptions).toHaveLength(7);
    const definitions = await setup.provider().provideMcpServerDefinitions({
      isCancellationRequested: false,
      onCancellationRequested: (() => ({ dispose() {} })) as vscode.Event<unknown>,
    });
    expect(definitions?.[0]).toMatchObject({
      label: "Unity Debugger Pure MCP",
      command: setup.boundary.executable,
      args: ["--pipe", PIPE_NAME, "--token", TOKEN, "--workspace", WORKSPACE_ROOT],
      version: "0.1.0",
    });

    await runtime.dispose();
    expect(setup.log.slice(-7)).toEqual([
      "dispose:provider",
      "close:publisher",
      "close:bridge",
      "dispose:tracker",
      "dispose:breakpoints",
      "dispose:terminate",
      "dispose:start",
    ]);
  });

  it("upgrades an active untracked exact session and shares one sequenced event runtime", async () => {
    const active = session();
    const setup = harness({ activeSession: active });
    const runtime = await activateWithDependencies(setup.context, setup.boundary);
    const bridge = setup.bridge();

    await request(bridge, "unity_debug_list_targets", {});
    await expect(request(bridge, "unity_debug_attach", { targetId: "opaque-target" }))
      .rejects.toMatchObject({ code: "ATTACH_FAILED" });
    expect(setup.api.startAttach).toHaveBeenCalledTimes(1);

    const tracker = await setup.listeners.tracker!.createDebugAdapterTracker(
      active as unknown as vscode.DebugSession,
    );
    expect(tracker).toBeDefined();
    await request(bridge, "unity_debug_list_targets", {});
    const attached = await request(bridge, "unity_debug_attach", {
      targetId: "opaque-target",
    }) as Record<string, unknown>;
    expect(attached).toMatchObject({ session: { tracked: true }, reused: true });
    expect(setup.api.startAttach).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(attached)).not.toContain(active.id);

    tracker!.onDidSendMessage?.({ type: "response", command: "attach", success: true });
    tracker!.onDidSendMessage?.({
      type: "event",
      event: "stopped",
      body: { reason: "breakpoint", threadId: 7 },
    });
    tracker!.onDidSendMessage?.({ type: "event", event: "breakpoint", body: {} });
    tracker!.onDidSendMessage?.({
      type: "event",
      event: "output",
      body: { category: "stdout", output: "game output" },
    });
    tracker!.onDidSendMessage?.({ type: "event", event: "continued", body: {} });
    tracker!.onDidSendMessage?.({
      type: "event",
      event: "output",
      body: { category: "console", output: "Domain Reload detected; waiting for assemblies." },
    });
    tracker!.onDidSendMessage?.({
      type: "event",
      event: "output",
      body: { category: "console", output: "reload progress" },
    });
    tracker!.onDidSendMessage?.({
      type: "event",
      event: "output",
      body: { category: "console", output: "Domain Reload complete;" },
    });

    const expected = [
      [0, "stopped", 1],
      [1, "breakpoint", 2],
      [2, "output", 3],
      [3, "continued", 4],
      [4, "reload-started", 5],
      [5, "reload-progress", 6],
      [6, "reload-completed", 7],
    ] as const;
    for (const [afterSequence, kind, sequence] of expected) {
      const result = await request(bridge, "unity_debug_wait_for_event", {
        afterSequence,
        kinds: [kind],
        timeoutMs: 0,
      }) as { event: { kind: string; sequence: number }; eventSequence: number };
      expect(result.event).toMatchObject({ kind, sequence });
      expect(result.eventSequence).toBe(7);
    }

    tracker!.onDidSendMessage?.({ type: "event", event: "terminated", body: {} });
    const terminated = await request(bridge, "unity_debug_wait_for_event", {
      afterSequence: 7,
      kinds: ["terminated"],
      timeoutMs: 0,
    }) as { event: { kind: string; sequence: number } };
    expect(terminated.event).toEqual(expect.objectContaining({ kind: "terminated", sequence: 8 }));
    setup.listeners.terminate?.(active as unknown as vscode.DebugSession);
    await Promise.resolve();
    await expect(request(bridge, "unity_debug_status", {})).resolves.toEqual({
      session: null,
      state: "not-attached",
      eventSequence: 0,
    });

    await runtime.dispose();
  });

  it("forwards bridge client identity and cancellation and revokes UI-deleted ownership", async () => {
    const active = session();
    const setup = harness({ activeSession: active });
    const runtime = await activateWithDependencies(setup.context, setup.boundary);
    const bridge = setup.bridge();
    await setup.listeners.tracker!.createDebugAdapterTracker(active as unknown as vscode.DebugSession);

    await request(bridge, "unity_debug_list_targets", {}, "client-a");
    bridge.onDisconnect?.({ connectionId: "client-a", signal: new AbortController().signal });
    await expect(request(bridge, "unity_debug_attach", { targetId: "opaque-target" }, "client-a"))
      .rejects.toMatchObject({ code: "NO_TARGET" });

    const controller = new AbortController();
    controller.abort();
    await expect(request(bridge, "unity_debug_status", {}, "client-b", controller.signal))
      .rejects.toMatchObject({ code: "CANCELLED" });

    const added = await request(bridge, "unity_debug_add_breakpoint", {
      sourcePath: SOURCE_PATH,
      line: 1,
    }) as { breakpoint: { breakpointRef: string } };
    const vscodeModule = await import("vscode");
    const created = vscodeModule.debug.breakpoints[0]!;
    setup.listeners.breakpoints?.({
      added: [],
      removed: [created],
      changed: [],
    } as vscode.BreakpointsChangeEvent);
    await expect(request(bridge, "unity_debug_remove_breakpoint", {
      breakpointRef: added.breakpoint.breakpointRef,
    })).rejects.toMatchObject({ code: "STALE_REFERENCE" });

    await runtime.dispose();
  });

  it("does not reuse tracking state or opaque refs for a replacement session object", async () => {
    const original = session("reused-raw-id");
    const replacement = session("reused-raw-id");
    const setup = harness({ activeSession: original });
    const runtime = await activateWithDependencies(setup.context, setup.boundary);
    const bridge = setup.bridge();
    await setup.listeners.tracker!.createDebugAdapterTracker(
      original as unknown as vscode.DebugSession,
    );
    await request(bridge, "unity_debug_list_targets", {});
    const first = await request(bridge, "unity_debug_attach", {
      targetId: "opaque-target",
    }) as { session: { sessionRef: string }; reused: boolean };
    expect(first.reused).toBe(true);

    setup.listeners.start?.(
      session("reused-raw-id", "other-debugger") as unknown as vscode.DebugSession,
    );
    const afterForeign = await request(bridge, "unity_debug_status", {}) as {
      session: { sessionRef: string };
    };
    expect(afterForeign.session.sessionRef).toBe(first.session.sessionRef);

    setup.listeners.start?.(replacement as unknown as vscode.DebugSession);
    await expect(request(bridge, "unity_debug_status", {})).resolves.toEqual({
      session: null,
      state: "not-attached",
      eventSequence: 0,
    });
    setup.listeners.terminate?.(original as unknown as vscode.DebugSession);
    await setup.listeners.tracker!.createDebugAdapterTracker(
      replacement as unknown as vscode.DebugSession,
    );
    await request(bridge, "unity_debug_list_targets", {});
    const second = await request(bridge, "unity_debug_attach", {
      targetId: "opaque-target",
    }) as { session: { sessionRef: string }; reused: boolean };
    expect(second.reused).toBe(true);
    expect(second.session.sessionRef).not.toBe(first.session.sessionRef);

    await runtime.dispose();
  });

  it("rejects an old pending event wait immediately when an exact session is replaced", async () => {
    vi.useFakeTimers();
    const original = session("pending-replacement");
    const replacement = session("pending-replacement");
    const setup = harness({ activeSession: original });
    const runtime = await activateWithDependencies(setup.context, setup.boundary);
    const bridge = setup.bridge();
    await setup.listeners.tracker!.createDebugAdapterTracker(
      original as unknown as vscode.DebugSession,
    );
    await request(bridge, "unity_debug_list_targets", {});
    await request(bridge, "unity_debug_attach", { targetId: "opaque-target" });
    const pending = request(bridge, "unity_debug_wait_for_event", {
      afterSequence: 0,
      kinds: ["output"],
      timeoutMs: 60_000,
    });
    const rejection = pending.catch((error: unknown) => error);
    expect(vi.getTimerCount()).toBe(1);

    setup.listeners.start?.(replacement as unknown as vscode.DebugSession);

    expect(vi.getTimerCount()).toBe(0);
    await expect(rejection).resolves.toMatchObject({ code: "NOT_ATTACHED" });
    await runtime.dispose();
  });

  it("delivers a synthesized terminated event before exact session cleanup", async () => {
    vi.useFakeTimers();
    const active = session("synthetic-termination");
    const setup = harness({ activeSession: active });
    const runtime = await activateWithDependencies(setup.context, setup.boundary);
    const bridge = setup.bridge();
    await setup.listeners.tracker!.createDebugAdapterTracker(
      active as unknown as vscode.DebugSession,
    );
    await request(bridge, "unity_debug_list_targets", {});
    await request(bridge, "unity_debug_attach", { targetId: "opaque-target" });
    const pending = request(bridge, "unity_debug_wait_for_event", {
      afterSequence: 0,
      kinds: ["terminated"],
      timeoutMs: 1_000,
    }) as Promise<{ event: { kind: string; sequence: number }; state: string }>;
    const unmatched = request(bridge, "unity_debug_wait_for_event", {
      afterSequence: 0,
      kinds: ["output"],
      timeoutMs: 60_000,
    }).catch((error: unknown) => error);

    setup.listeners.terminate?.(active as unknown as vscode.DebugSession);

    await expect(pending).resolves.toMatchObject({
      event: { kind: "terminated", sequence: 1 },
      state: "terminated",
    });
    await Promise.resolve();
    await expect(unmatched).resolves.toMatchObject({ code: "NOT_ATTACHED" });
    expect(vi.getTimerCount()).toBe(0);
    await expect(request(bridge, "unity_debug_status", {})).resolves.toEqual({
      session: null,
      state: "not-attached",
      eventSequence: 0,
    });
    await runtime.dispose();
  });

  it("invalidates pending event waits during extension deactivation", async () => {
    vi.useFakeTimers();
    const active = session("pending-deactivation");
    const setup = harness({ activeSession: active });
    const runtime = await activateWithDependencies(setup.context, setup.boundary);
    const bridge = setup.bridge();
    await setup.listeners.tracker!.createDebugAdapterTracker(
      active as unknown as vscode.DebugSession,
    );
    await request(bridge, "unity_debug_list_targets", {});
    await request(bridge, "unity_debug_attach", { targetId: "opaque-target" });
    const pending = request(bridge, "unity_debug_wait_for_event", {
      afterSequence: 0,
      timeoutMs: 60_000,
    }).catch((error: unknown) => error);
    expect(vi.getTimerCount()).toBe(1);

    await runtime.dispose();

    await expect(pending).resolves.toMatchObject({ code: "NOT_ATTACHED" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up lifecycle hooks after bridge listen failure", async () => {
    const setup = harness({ failListen: true });
    await expect(activateWithDependencies(setup.context, setup.boundary))
      .rejects.toThrow("listen failed");
    expect(setup.context.subscriptions).toHaveLength(0);
    expect(setup.log.slice(-5)).toEqual([
      "close:bridge",
      "dispose:tracker",
      "dispose:breakpoints",
      "dispose:terminate",
      "dispose:start",
    ]);
  });

  it.each([
    {
      name: "publisher start",
      options: { failPublisherStart: true },
      failure: "publisher start failed",
    },
    {
      name: "provider registration",
      options: { failProvider: true },
      failure: "provider failed",
    },
  ])("closes publisher and Host after $name failure", async ({ options, failure }) => {
    const setup = harness(options);
    await expect(activateWithDependencies(setup.context, setup.boundary)).rejects.toThrow(failure);
    expect(setup.context.subscriptions).toHaveLength(0);
    expect(setup.log.slice(-6)).toEqual([
      "close:publisher",
      "close:bridge",
      "dispose:tracker",
      "dispose:breakpoints",
      "dispose:terminate",
      "dispose:start",
    ]);
  });

  it("fails before dependency or listeners on an unsupported host", async () => {
    const setup = harness({ platform: "linux" });
    await expect(activateWithDependencies(setup.context, setup.boundary)).rejects.toThrow(
      "Windows x64",
    );
    expect(setup.log).toEqual([]);
    expect(setup.subscriptions).toHaveLength(0);
  });

  it("still disposes every lifecycle hook when bridge shutdown fails", async () => {
    const setup = harness({ failClose: true });
    const runtime = await activateWithDependencies(setup.context, setup.boundary);
    await expect(runtime.dispose()).rejects.toThrow("close failed");
    expect(setup.log.slice(-7)).toEqual([
      "dispose:provider",
      "close:publisher",
      "close:bridge",
      "dispose:tracker",
      "dispose:breakpoints",
      "dispose:terminate",
      "dispose:start",
    ]);
  });

  it("still closes the Host and lifecycle hooks when publisher cleanup fails", async () => {
    const setup = harness({ failPublisherClose: true });
    const runtime = await activateWithDependencies(setup.context, setup.boundary);
    await expect(runtime.dispose()).rejects.toThrow("publisher close failed");
    expect(setup.log.slice(-7)).toEqual([
      "dispose:provider",
      "close:publisher",
      "close:bridge",
      "dispose:tracker",
      "dispose:breakpoints",
      "dispose:terminate",
      "dispose:start",
    ]);
  });

  it("makes every concurrent dispose wait for publisher cleanup", async () => {
    const setup = harness({ deferPublisherClose: true });
    const runtime = await activateWithDependencies(setup.context, setup.boundary);
    const first = runtime.dispose();
    await vi.waitFor(() => expect(setup.log).toContain("close:publisher"));

    let secondSettled = false;
    const second = runtime.dispose().then(() => { secondSettled = true; });
    await Promise.resolve();
    await Promise.resolve();
    const settledBeforeRelease = secondSettled;
    setup.releasePublisherClose();
    await Promise.all([first, second]);
    expect(settledBeforeRelease).toBe(false);
    expect(setup.log.filter((entry) => entry === "close:publisher")).toHaveLength(1);
    expect(setup.log.filter((entry) => entry === "close:bridge")).toHaveLength(1);
  });

  it("keeps reverse teardown order when the host disposes subscriptions before deactivate settles", async () => {
    const setup = harness();
    const runtime = await activateWithDependencies(setup.context, setup.boundary);

    const deactivation = runtime.dispose();
    for (const disposable of setup.context.subscriptions) {
      disposable.dispose();
    }
    await deactivation;

    expect(setup.log.slice(-7)).toEqual([
      "dispose:provider",
      "close:publisher",
      "close:bridge",
      "dispose:tracker",
      "dispose:breakpoints",
      "dispose:terminate",
      "dispose:start",
    ]);
  });
});
