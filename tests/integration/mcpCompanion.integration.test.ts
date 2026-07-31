import { spawnSync } from "node:child_process";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { beforeAll, describe, expect, it, vi } from "vitest";

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
    addBreakpoints(items: unknown[]) {
      debug.breakpoints.push(...items);
    },
    removeBreakpoints(items: unknown[]) {
      debug.breakpoints = debug.breakpoints.filter((item) => !items.includes(item));
    },
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

import * as vscode from "vscode";

import {
  BridgeHost,
  type BridgeDescriptor,
  type BridgeToolHandler,
} from "../../src/bridge/bridgeHost.js";
import { TOOL_NAMES, type ToolName } from "../../src/bridge/protocol.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const bundledServer = path.join(repositoryRoot, "server", "dist", "server.cjs");
const workspaceRoot = repositoryRoot;
const sourcePath = path.join(workspaceRoot, "package.json");
const extensionModulePath = "../../src/extension.js";

beforeAll(() => {
  const built = spawnSync(process.execPath, ["esbuild.mjs"], {
    cwd: path.join(repositoryRoot, "server"),
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  expect(built.status, `${built.stdout}\n${built.stderr}`).toBe(0);
}, 30_000);

type Scenario = "normal" | "reload" | "exception";

interface Listeners {
  start?: (session: vscode.DebugSession) => void;
  terminate?: (session: vscode.DebugSession) => void;
  trackerFactory?: vscode.DebugAdapterTrackerFactory;
}

class FakeVsCodeSession {
  public readonly id = "simulated-vscode-session";
  public readonly type = "unity-debugger-pure";
  public readonly name = "Simulated Unity";
  public readonly configuration = {};
  public readonly workspaceFolder = {
    index: 0,
    name: path.basename(workspaceRoot),
    uri: { fsPath: workspaceRoot },
  };
  public readonly getDebugProtocolBreakpoint = vi.fn();
  public readonly evaluationContexts: string[] = [];
  public readonly exceptionBreakpointRequests: unknown[] = [];
  public scenario: Scenario = "normal";
  public tracker?: vscode.DebugAdapterTracker;

  public async customRequest(command: string, body?: unknown): Promise<unknown> {
    switch (command) {
      case "threads":
        return { threads: [{ id: 71, name: "Main Thread" }, { id: 72, name: "Worker" }] };
      case "stackTrace":
        return {
          stackFrames: [{
            id: 401,
            name: "Update",
            line: 12,
            column: 3,
            source: { name: "Player.cs", path: sourcePath },
          }],
          totalFrames: 1,
        };
      case "scopes":
        return { scopes: [{ name: "Locals", variablesReference: 501, expensive: false }] };
      case "variables":
        return {
          variables: [
            { name: "health", value: "100", type: "int", variablesReference: 0 },
            { name: "player", value: "Player", type: "Player", variablesReference: 601 },
          ],
        };
      case "evaluate": {
        const context = (body as { readonly context?: unknown } | undefined)?.context;
        if (typeof context === "string") {
          this.evaluationContexts.push(context);
        }
        return {
          result: context === "repl" ? "damage applied" : "100",
          type: context === "repl" ? "void" : "int",
          variablesReference: 0,
        };
      }
      case "stepIn":
      case "next":
      case "stepOut":
        this.emit({ type: "event", event: "continued", body: {} });
        this.emit({
          type: "event",
          event: "stopped",
          body: { reason: "step", threadId: 71 },
        });
        return {};
      case "continue":
        this.emit({ type: "event", event: "continued", body: {} });
        if (this.scenario === "reload") {
          this.emit({
            type: "event",
            event: "output",
            body: {
              category: "console",
              output: "Domain Reload detected; waiting for assemblies.",
            },
          });
        }
        return { allThreadsContinued: true };
      case "setExceptionBreakpoints":
        this.exceptionBreakpointRequests.push(body);
        if (this.scenario === "exception") {
          this.emit({
            type: "event",
            event: "stopped",
            body: { reason: "exception", threadId: 71 },
          });
        }
        return {};
      default:
        return {};
    }
  }

  public completeReload(): void {
    this.emit({
      type: "event",
      event: "output",
      body: { category: "console", output: "Domain Reload complete; assemblies loaded." },
    });
  }

  public stopAfterReload(): void {
    this.emit({
      type: "event",
      event: "stopped",
      body: { reason: "breakpoint", threadId: 71 },
    });
  }

  public emit(message: unknown): void {
    this.tracker?.onDidSendMessage?.(message);
  }
}

describe("packaged MCP companion simulated session", () => {
  it("executes a complete debugger workflow over a real pipe and MCP process", async () => {
    const listeners: Listeners = {};
    const subscriptions: vscode.Disposable[] = [];
    const session = new FakeVsCodeSession();
    const stoppedByVsCode = vi.fn(async () => undefined);
    const publisherStarted = vi.fn(async () => undefined);
    const publisherClosed = vi.fn(async () => undefined);
    let bridgeHost: BridgeHost | undefined;
    let descriptor: BridgeDescriptor | undefined;

    const debuggerApi = Object.freeze({
      apiVersion: 1 as const,
      extensionVersion: "0.2.0",
      debugType: "unity-debugger-pure" as const,
      discoverTargets: vi.fn(async () => Object.freeze([Object.freeze({
        targetId: "simulated-target",
        processId: 2468,
        projectName: "MyGame",
        workspaceRoot,
        projectVersion: "2022.3.62f3",
        source: "advertisement" as const,
      })])),
      startAttach: vi.fn(async (targetId: string) => {
        expect(targetId).toBe("simulated-target");
        listeners.start?.(session as unknown as vscode.DebugSession);
        const tracker = await listeners.trackerFactory!.createDebugAdapterTracker(
          session as unknown as vscode.DebugSession,
        );
        expect(tracker).toBeDefined();
        session.tracker = tracker ?? undefined;
        session.emit({ type: "response", command: "attach", success: true });
        session.emit({
          type: "event",
          event: "stopped",
          body: { reason: "breakpoint", threadId: 71 },
        });
        return { sessionId: session.id, targetId };
      }),
    });
    const disposable = (): vscode.Disposable => ({ dispose() {} });
    const boundary = {
      platform: "win32",
      arch: "x64",
      executable: path.join(repositoryRoot, "dist", "mcp-bridge.exe"),
      version: "0.1.0",
      hasRequiredCapabilities: () => true,
      getDebuggerExtension: () => ({ activate: async () => debuggerApi }),
      isWorkspaceTrusted: () => true,
      workspaceRoots: () => [workspaceRoot],
      stopDebugging: stoppedByVsCode,
      activeDebugSession: () => undefined,
      onDidStartDebugSession(listener: (session: vscode.DebugSession) => void) {
        listeners.start = listener;
        return disposable();
      },
      onDidTerminateDebugSession(listener: (session: vscode.DebugSession) => void) {
        listeners.terminate = listener;
        return disposable();
      },
      onDidChangeBreakpoints() {
        return disposable();
      },
      registerDebugAdapterTrackerFactory(
        type: string,
        factory: vscode.DebugAdapterTrackerFactory,
      ) {
        expect(type).toBe("unity-debugger-pure");
        listeners.trackerFactory = factory;
        return disposable();
      },
      createBridgeHost(handler: BridgeToolHandler) {
        bridgeHost = new BridgeHost({ handler });
        return {
          async listen() {
            descriptor = await bridgeHost!.listen();
            return descriptor;
          },
          close: () => bridgeHost!.close(),
        };
      },
      async createLiveHostRegistrationPublisher() {
        return {
          start: publisherStarted,
          close: publisherClosed,
        };
      },
      registerMcpProvider: () => disposable(),
      statExecutable: async () => ({ isFile: () => true }),
    };
    const { activateWithDependencies } = await import(extensionModulePath) as {
      activateWithDependencies(
        context: vscode.ExtensionContext,
        dependencies: unknown,
      ): Promise<{ dispose(): Promise<void> }>;
    };
    const runtime = await activateWithDependencies(
      { subscriptions } as unknown as vscode.ExtensionContext,
      boundary,
    );
    expect(descriptor).toBeDefined();

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        bundledServer,
        "--pipe",
        descriptor!.pipeName,
        "--token",
        descriptor!.token,
        "--workspace",
        workspaceRoot,
      ],
      cwd: repositoryRoot,
      stderr: "pipe",
    });
    const client = new Client({ name: "simulated-companion-test", version: "1.0.0" });

    try {
      await client.connect(transport, { timeout: 5_000 });
      expect((await client.listTools()).tools.map(({ name }) => name)).toEqual([...TOOL_NAMES]);

      const targets = await success(client, "unity_debug_list_targets", {});
      const targetId = (targets.targets as Array<{ targetId: string }>)[0]!.targetId;
      const attached = await success(client, "unity_debug_attach", { targetId });
      const sessionRef = (attached.session as { sessionRef: string }).sessionRef;

      const added = await success(client, "unity_debug_add_breakpoint", {
        sourcePath,
        line: 1,
        condition: "health > 0",
      });
      expect((added.breakpoint as { breakpointRef: string }).breakpointRef).toBeTypeOf("string");
      expect(vscode.debug.breakpoints).toHaveLength(1);
      const [createdBreakpoint] = vscode.debug.breakpoints as readonly vscode.SourceBreakpoint[];
      expect(createdBreakpoint).toBeInstanceOf(vscode.SourceBreakpoint);
      expect(createdBreakpoint).toMatchObject({
        enabled: true,
        condition: "health > 0",
        location: {
          uri: { fsPath: sourcePath, scheme: "file" },
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
        },
      });
      const firstStop = await success(client, "unity_debug_wait_for_event", {
        sessionRef,
        afterSequence: 0,
        kinds: ["stopped"],
        timeoutMs: 1_000,
      });
      expect(firstStop.event).toMatchObject({ kind: "stopped", reason: "breakpoint" });

      const snapshot = await success(client, "unity_debug_snapshot", { sessionRef });
      const threads = await success(client, "unity_debug_threads", { sessionRef });
      const threadRef = (threads.threads as Array<{ threadRef: string }>)[0]!.threadRef;
      const stack = await success(client, "unity_debug_stack_trace", {
        sessionRef,
        threadRef,
      });
      const frameRef = (stack.frames as Array<{ frameRef: string }>)[0]!.frameRef;
      const scopes = await success(client, "unity_debug_scopes", { sessionRef, frameRef });
      const variablesRef = (scopes.scopes as Array<{ variablesRef: string }>)[0]!.variablesRef;
      const variables = await success(client, "unity_debug_variables", {
        sessionRef,
        variablesRef,
      });
      expect(snapshot).toMatchObject({ state: "stopped", reason: "breakpoint" });
      expect(variables.variables).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "health", value: "100" }),
      ]));

      await expect(success(client, "unity_debug_evaluate_safe", {
        sessionRef,
        frameRef,
        expression: "health",
      })).resolves.toMatchObject({ result: "100" });
      expect(session.evaluationContexts).toEqual(["hover"]);
      await expect(toolError(client, "unity_debug_evaluate_explicit", {
        sessionRef,
        frameRef,
        expression: "ApplyDamage()",
        allowSideEffects: false,
      })).resolves.toMatchObject({ code: "DAP_FAILURE" });
      expect(session.evaluationContexts).toEqual(["hover"]);
      await expect(success(client, "unity_debug_evaluate_explicit", {
        sessionRef,
        frameRef,
        expression: "ApplyDamage()",
        allowSideEffects: true,
      })).resolves.toMatchObject({ result: "damage applied" });
      expect(session.evaluationContexts).toEqual(["hover", "repl"]);

      for (const kind of ["in", "over", "out"] as const) {
        const stepped = await success(client, "unity_debug_step", { sessionRef, kind });
        expect(stepped).toMatchObject({ kind, state: "stopped" });
      }

      session.scenario = "reload";
      const beforeReload = (await success(client, "unity_debug_status", { sessionRef }))
        .eventSequence as number;
      await success(client, "unity_debug_continue", { sessionRef });
      const reloadStarted = await success(client, "unity_debug_wait_for_event", {
        sessionRef,
        afterSequence: beforeReload,
        kinds: ["reload-started"],
        timeoutMs: 1_000,
      });
      expect(reloadStarted.event).toMatchObject({ kind: "reload-started", phase: "reloading" });
      await expect(toolError(client, "unity_debug_scopes", { sessionRef, frameRef }))
        .resolves.toEqual({
          code: "RELOADING",
          message: "The Unity domain is reloading.",
          retryable: true,
          currentState: "reloading",
          action: "Wait for reload completion before retrying the request.",
        });

      const reloadSequence = (reloadStarted.event as { sequence: number }).sequence;
      session.completeReload();
      await success(client, "unity_debug_wait_for_event", {
        sessionRef,
        afterSequence: reloadSequence,
        kinds: ["reload-completed"],
        timeoutMs: 1_000,
      });
      session.stopAfterReload();
      await expect(toolError(client, "unity_debug_scopes", { sessionRef, frameRef }))
        .resolves.toMatchObject({ code: "STALE_REFERENCE" });
      const refreshedThreads = await success(client, "unity_debug_threads", { sessionRef });
      const refreshedThreadRef = (
        refreshedThreads.threads as Array<{ threadRef: string }>
      )[0]!.threadRef;
      expect(refreshedThreadRef).not.toBe(threadRef);
      const refreshedStack = await success(client, "unity_debug_stack_trace", {
        sessionRef,
        threadRef: refreshedThreadRef,
      });
      const refreshedFrameRef = (
        refreshedStack.frames as Array<{ frameRef: string }>
      )[0]!.frameRef;
      expect(refreshedFrameRef).not.toBe(frameRef);
      const refreshedScopes = await success(client, "unity_debug_scopes", {
        sessionRef,
        frameRef: refreshedFrameRef,
      });
      const refreshedVariablesRef = (
        refreshedScopes.scopes as Array<{ variablesRef: string }>
      )[0]!.variablesRef;
      expect(refreshedVariablesRef).not.toBe(variablesRef);
      const retriedVariables = await success(client, "unity_debug_variables", {
        sessionRef,
        variablesRef: refreshedVariablesRef,
      });
      expect(retriedVariables.variables).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "health", value: "100" }),
      ]));
      const retriedSnapshot = await success(client, "unity_debug_snapshot", { sessionRef });
      expect(retriedSnapshot).toMatchObject({ state: "stopped", reason: "breakpoint" });

      session.scenario = "exception";
      const beforeException = retriedSnapshot.eventSequence as number;
      await success(client, "unity_debug_set_exception_breakpoints", {
        sessionRef,
        mode: "all",
      });
      expect(session.exceptionBreakpointRequests).toEqual([{ filters: ["all"] }]);
      const exceptionStop = await success(client, "unity_debug_wait_for_event", {
        sessionRef,
        afterSequence: beforeException,
        kinds: ["stopped"],
        timeoutMs: 1_000,
      });
      expect(exceptionStop.event).toMatchObject({ kind: "stopped", reason: "exception" });

      const disconnected = await success(client, "unity_debug_disconnect", {
        sessionRef,
        terminateSession: false,
      });
      expect(disconnected).toEqual({ sessionRef, terminated: false });
      expect(stoppedByVsCode).not.toHaveBeenCalled();
      expect(listeners.terminate).toBeDefined();
    } finally {
      await client.close().catch(() => undefined);
      await runtime.dispose();
      expect(publisherStarted).toHaveBeenCalledOnce();
      expect(publisherClosed).toHaveBeenCalledOnce();
    }
  }, 30_000);
});

async function success(
  client: Client,
  name: ToolName,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  expect(result).not.toHaveProperty("toolResult");
  const response = result as {
    readonly isError?: boolean;
    readonly structuredContent?: Record<string, unknown>;
  };
  expect(response.isError, `${name}: ${JSON.stringify(result)}`).not.toBe(true);
  expect(response.structuredContent).toBeDefined();
  return response.structuredContent!;
}

async function toolError(
  client: Client,
  name: ToolName,
  args: Record<string, unknown>,
): Promise<{
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly currentState: string;
  readonly action: string;
}> {
  const result = await client.callTool({ name, arguments: args });
  const response = result as {
    readonly isError?: boolean;
    readonly structuredContent?: Record<string, unknown>;
  };
  expect(response.isError).toBe(true);
  expect(response.structuredContent).toMatchObject({
    code: expect.any(String),
    message: expect.any(String),
    retryable: expect.any(Boolean),
    currentState: expect.any(String),
    action: expect.any(String),
  });
  return response.structuredContent as {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly currentState: string;
    readonly action: string;
  };
}
