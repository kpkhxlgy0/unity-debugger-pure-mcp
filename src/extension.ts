import path from "node:path";

import * as vscode from "vscode";

import {
  BridgeHost,
  type BridgeDescriptor,
  type BridgeToolHandler,
} from "./bridge/bridgeHost.js";
import { BreakpointRegistry } from "./debug/breakpointRegistry.js";
import { SessionCommandQueue } from "./debug/commandQueue.js";
import { DapGateway } from "./debug/dapGateway.js";
import { EventBuffer } from "./debug/eventBuffer.js";
import { ReferenceStore } from "./debug/referenceStore.js";
import { SessionRegistry } from "./debug/sessionRegistry.js";
import {
  EventSequencer,
  StateProjector,
  type DebugSessionState,
} from "./debug/stateProjector.js";
import { DependencyAdapter } from "./dependencyAdapter.js";
import {
  LiveHostRegistrationPublisher,
  verifyPackagedBridgeIntegrity,
} from "./external/liveHostRegistrationPublisher.js";
import { createVscodeExternalClientCommands } from "./external/config/externalClientCommands.js";
import {
  createMcpProvider,
  MCP_PROVIDER_ID,
} from "./mcpProvider.js";
import { ToolDispatcher } from "./tools/toolDispatcher.js";
import { notAttachedError } from "./tools/errors.js";

const DEBUG_TYPE = "unity-debugger-pure";

interface DebuggerExtensionLike {
  activate(): unknown;
}

interface BridgeHostLike {
  listen(): Promise<BridgeDescriptor>;
  close(): Promise<void>;
}

interface LiveHostPublisherLike {
  start(): Promise<void>;
  close(): Promise<void>;
}

interface FileStatus {
  isFile(): boolean;
}

export interface ExtensionCompositionBoundary {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly executable: string;
  readonly version: string;
  readonly statExecutable?: (executable: string) => Promise<FileStatus>;
  hasRequiredCapabilities(): boolean;
  getDebuggerExtension(id: string): DebuggerExtensionLike | undefined;
  isWorkspaceTrusted(): boolean;
  workspaceRoots(): readonly string[];
  stopDebugging(session: vscode.DebugSession): PromiseLike<void>;
  activeDebugSession(): vscode.DebugSession | undefined;
  onDidStartDebugSession(
    listener: (session: vscode.DebugSession) => void,
  ): vscode.Disposable;
  onDidTerminateDebugSession(
    listener: (session: vscode.DebugSession) => void,
  ): vscode.Disposable;
  onDidChangeBreakpoints(
    listener: (event: vscode.BreakpointsChangeEvent) => void,
  ): vscode.Disposable;
  registerDebugAdapterTrackerFactory(
    debugType: string,
    factory: vscode.DebugAdapterTrackerFactory,
  ): vscode.Disposable;
  registerExternalClientCommands(): vscode.Disposable;
  createBridgeHost(handler: BridgeToolHandler): BridgeHostLike;
  createLiveHostRegistrationPublisher(
    descriptor: BridgeDescriptor,
  ): Promise<LiveHostPublisherLike>;
  registerMcpProvider(
    id: string,
    provider: vscode.McpServerDefinitionProvider<vscode.McpStdioServerDefinition>,
  ): vscode.Disposable;
}

export interface ExtensionRuntime {
  dispose(): Promise<void>;
}

interface SessionRuntime {
  readonly session: vscode.DebugSession;
  readonly sessionRef: string;
  readonly projector: StateProjector;
  readonly events: EventBuffer;
}

let activeRuntime: ExtensionRuntime | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const runtime = await activateWithDependencies(
    context,
    productionBoundary(context),
  );
  activeRuntime = runtime;
}

export async function deactivate(): Promise<void> {
  const runtime = activeRuntime;
  activeRuntime = undefined;
  await runtime?.dispose();
}

export async function activateWithDependencies(
  context: vscode.ExtensionContext,
  boundary: ExtensionCompositionBoundary,
): Promise<ExtensionRuntime> {
  validateHost(boundary);

  const dependency = new DependencyAdapter(boundary.getDebuggerExtension);
  await dependency.activate();

  const sessions = new SessionRegistry();
  const queue = new SessionCommandQueue();
  const references = new ReferenceStore();
  const breakpoints = new BreakpointRegistry();
  const dap = new DapGateway();
  const runtimeBySessionId = new Map<string, SessionRuntime>();
  const runtimeBySessionRef = new Map<string, SessionRuntime>();
  const lifecycleDisposables: vscode.Disposable[] = [];
  let host: BridgeHostLike | undefined;
  let publisher: LiveHostPublisherLike | undefined;
  let providerDisposable: vscode.Disposable | undefined;
  let publisherCloseOperation: Promise<void> | undefined;
  let closeOperation: Promise<void> | undefined;
  let disposed = false;

  const closeBridge = (): Promise<void> => {
    if (closeOperation === undefined) {
      closeOperation = host?.close() ?? Promise.resolve();
    }
    return closeOperation;
  };
  const closePublisher = (): Promise<void> => {
    if (publisherCloseOperation === undefined) {
      publisherCloseOperation = publisher?.close() ?? Promise.resolve();
    }
    return publisherCloseOperation;
  };
  const disposeResources = async (): Promise<void> => {
    if (disposed) {
      await publisherCloseOperation;
      await closeOperation;
      return;
    }
    disposed = true;
    let failure: unknown;
    try {
      providerDisposable?.dispose();
    } catch (error) {
      failure = error;
    }
    for (const runtime of runtimeBySessionRef.values()) {
      runtime.events.invalidate(notAttachedError());
    }
    try {
      await closePublisher();
    } catch (error) {
      failure ??= error;
    }
    try {
      await closeBridge();
    } catch (error) {
      failure ??= error;
    }
    for (let index = lifecycleDisposables.length - 1; index >= 0; index -= 1) {
      try {
        lifecycleDisposables[index]!.dispose();
      } catch (error) {
        failure ??= error;
      }
    }
    runtimeBySessionId.clear();
    runtimeBySessionRef.clear();
    if (failure !== undefined) {
      throw failure;
    }
  };

  const stateForSession = (session: vscode.DebugSession): DebugSessionState | undefined => {
    const runtime = runtimeBySessionId.get(session.id);
    return runtime?.session === session ? runtime.projector.snapshot() : undefined;
  };

  const dispatcher = new ToolDispatcher({
    dependency,
    sessions,
    queue,
    breakpoints,
    workspace: {
      isTrusted: () => boundary.isWorkspaceTrusted(),
      roots: () => boundary.workspaceRoots(),
    },
    debug: {
      stopDebugging: (session) => boundary.stopDebugging(session),
    },
    stateForSession,
    references,
    dap,
    eventsForSession: (sessionRef) => runtimeBySessionRef.get(sessionRef)?.events,
  });

  const acceptAdapterMessage = (runtime: SessionRuntime, message: unknown): void => {
    try {
      const before = runtime.projector.snapshot();
      const projected = runtime.projector.acceptAdapterMessage(message);
      let appended = false;
      if (projected !== undefined) {
        runtime.events.appendProjected(projected);
        appended = true;
      } else {
        appended = appendOrdinaryEvent(runtime.events, before, message);
      }
      const after = runtime.projector.snapshot();
      if (appended || stateChanged(before, after)) {
        dispatcher.onSessionStateChanged(runtime.sessionRef);
      }
    } catch {
      // Tracker messages originate outside the companion trust boundary.
    }
  };

  const removeReplacedSession = (session: vscode.DebugSession): void => {
    const existing = sessions.findBySessionId(session.id);
    if (existing === undefined) {
      return;
    }
    const existingSession = sessions.resolveDebugSession(existing);
    if (existingSession === session) {
      return;
    }
    sessions.remove(existingSession);
    const runtime = runtimeBySessionId.get(session.id);
    if (runtime !== undefined && runtime.session === existingSession) {
      runtime.events.invalidate(notAttachedError());
      runtimeBySessionId.delete(session.id);
      runtimeBySessionRef.delete(runtime.sessionRef);
    }
    references.invalidate(existing.sessionRef);
    dispatcher.onSessionStateChanged(existing.sessionRef);
  };

  const createTracker = (
    session: vscode.DebugSession,
  ): vscode.DebugAdapterTracker | undefined => {
    if (!isUnitySession(session)) {
      return undefined;
    }
    let selection: ReturnType<SessionRegistry["register"]>;
    try {
      removeReplacedSession(session);
      selection = sessions.register(session, true);
    } catch {
      return undefined;
    }
    if (selection === undefined) {
      return undefined;
    }
    let runtime = runtimeBySessionId.get(session.id);
    if (runtime === undefined || runtime.session !== session) {
      if (runtime !== undefined) {
        runtime.events.invalidate(notAttachedError());
        references.invalidate(runtime.sessionRef);
        runtimeBySessionRef.delete(runtime.sessionRef);
      }
      const sequencer = new EventSequencer();
      runtime = Object.freeze({
        session,
        sessionRef: selection.sessionRef,
        projector: new StateProjector(sequencer),
        events: new EventBuffer(sequencer),
      });
      runtimeBySessionId.set(session.id, runtime);
      runtimeBySessionRef.set(selection.sessionRef, runtime);
      dispatcher.onSessionStateChanged(selection.sessionRef);
    }
    const captured = runtime;
    return Object.freeze({
      onDidSendMessage(message: unknown) {
        if (runtimeBySessionId.get(session.id) === captured) {
          acceptAdapterMessage(captured, message);
        }
      },
    });
  };

  const terminateSession = (session: vscode.DebugSession): void => {
    try {
      if (!isUnitySession(session)) {
        return;
      }
      const runtime = runtimeBySessionId.get(session.id);
      if (runtime !== undefined && runtime.session !== session) {
        return;
      }
      const selection = sessions.findBySessionId(session.id);
      if (selection === undefined) {
        return;
      }
      if (runtime !== undefined) {
        if (runtime.projector.snapshot().phase !== "terminated") {
          acceptAdapterMessage(runtime, {
            type: "event",
            event: "terminated",
            body: {},
          });
        }
      }
      queueMicrotask(() => {
        try {
          const current = sessions.findBySessionId(session.id);
          if (
            current?.sessionRef !== selection.sessionRef ||
            sessions.resolveDebugSession(current) !== session ||
            !sessions.remove(session)
          ) {
            return;
          }
          if (
            runtime !== undefined &&
            runtimeBySessionId.get(session.id) === runtime
          ) {
            runtime.events.invalidate(notAttachedError());
            runtimeBySessionId.delete(session.id);
            runtimeBySessionRef.delete(runtime.sessionRef);
          }
          references.invalidate(selection.sessionRef);
          dispatcher.onSessionStateChanged(selection.sessionRef);
        } catch {
          // A replacement session won the lifecycle race; keep its state.
        }
      });
    } catch {
      // VS Code lifecycle notifications must never escape into the host.
    }
  };

  try {
    lifecycleDisposables.push(onceDisposable(boundary.onDidStartDebugSession(
      (session) => {
        try {
          if (!isUnitySession(session)) {
            return;
          }
          removeReplacedSession(session);
          sessions.register(session, false);
        } catch {
          // Ignore malformed external session objects.
        }
      },
    )));
    lifecycleDisposables.push(onceDisposable(boundary.onDidTerminateDebugSession(
      terminateSession,
    )));
    lifecycleDisposables.push(onceDisposable(boundary.onDidChangeBreakpoints(
      (event) => breakpoints.acceptChanges(event),
    )));
    lifecycleDisposables.push(onceDisposable(
      boundary.registerDebugAdapterTrackerFactory(DEBUG_TYPE, {
        createDebugAdapterTracker: createTracker,
      }),
    ));
    lifecycleDisposables.push(onceDisposable(
      boundary.registerExternalClientCommands(),
    ));

    const activeSession = boundary.activeDebugSession();
    if (activeSession !== undefined) {
      sessions.register(activeSession, false);
    }

    host = boundary.createBridgeHost({
      callTool: (request) => dispatcher.call(
        request.name,
        request.input,
        request.connectionId,
        request.signal,
      ),
      onDisconnect: (context) => dispatcher.onDisconnect(context.connectionId),
    });
    const descriptor = await host.listen();
    publisher = await boundary.createLiveHostRegistrationPublisher(descriptor);
    await publisher.start();
    const provider = createMcpProvider({
      executable: boundary.executable,
      descriptor,
      workspaceRoots: Object.freeze([...boundary.workspaceRoots()]),
      version: boundary.version,
      ensureDebuggerApi: () => dependency.activate(),
      isWorkspaceTrusted: () => boundary.isWorkspaceTrusted(),
      statExecutable: boundary.statExecutable,
    });
    providerDisposable = onceDisposable(boundary.registerMcpProvider(
      MCP_PROVIDER_ID,
      provider,
    ));
    const bridgeDisposable = onceDisposable({
      dispose: () => {
        void closeBridge();
      },
    });
    const publisherDisposable = onceDisposable({
      dispose: () => {
        void closePublisher();
      },
    });
    context.subscriptions.push(
      providerDisposable,
      publisherDisposable,
      bridgeDisposable,
      ...[...lifecycleDisposables].reverse(),
    );
  } catch (error) {
    try {
      await disposeResources();
    } catch {
      // Preserve the activation failure after best-effort reverse cleanup.
    }
    throw error;
  }

  return Object.freeze({ dispose: disposeResources });
}

function appendOrdinaryEvent(
  events: EventBuffer,
  state: DebugSessionState,
  message: unknown,
): boolean {
  if (!isRecord(message) || message.type !== "event") {
    return false;
  }
  if (message.event === "breakpoint" && isRecord(message.body)) {
    events.append({ kind: "breakpoint" });
    return true;
  }
  if (message.event !== "output" || !isRecord(message.body)) {
    return false;
  }
  const output = message.body.output;
  if (typeof output !== "string") {
    return false;
  }
  events.append({
    kind: state.phase === "reloading" ? "reload-progress" : "output",
    output,
  });
  return true;
}

function stateChanged(before: DebugSessionState, after: DebugSessionState): boolean {
  return before.phase !== after.phase ||
    before.stopGeneration !== after.stopGeneration ||
    before.eventSequence !== after.eventSequence ||
    before.reason !== after.reason ||
    before.threadId !== after.threadId;
}

function onceDisposable(disposable: vscode.Disposable): vscode.Disposable {
  let disposed = false;
  return Object.freeze({
    dispose() {
      if (!disposed) {
        disposed = true;
        disposable.dispose();
      }
    },
  });
}

function validateHost(boundary: ExtensionCompositionBoundary): void {
  if (boundary.platform !== "win32" || boundary.arch !== "x64") {
    throw new Error("Unity Debugger Pure MCP requires a Windows x64 extension host.");
  }
  if (
    !boundary.hasRequiredCapabilities() ||
    boundary.executable.length === 0 ||
    boundary.version.length === 0
  ) {
    throw new Error("The required VS Code MCP capabilities are unavailable.");
  }
}

function productionBoundary(
  context: vscode.ExtensionContext,
): ExtensionCompositionBoundary {
  const version = readVersion(context);
  return {
    platform: process.platform,
    arch: process.arch,
    executable: context.asAbsolutePath(path.join("dist", "mcp-bridge.exe")),
    version,
    hasRequiredCapabilities: () =>
      typeof vscode.workspace.isTrusted === "boolean" &&
      typeof vscode.lm.registerMcpServerDefinitionProvider === "function",
    getDebuggerExtension: (id) => vscode.extensions.getExtension(id),
    isWorkspaceTrusted: () => vscode.workspace.isTrusted,
    workspaceRoots: () => Object.freeze(
      (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
    ),
    stopDebugging: (session) => vscode.debug.stopDebugging(session),
    activeDebugSession: () => vscode.debug.activeDebugSession,
    onDidStartDebugSession: (listener) => vscode.debug.onDidStartDebugSession(listener),
    onDidTerminateDebugSession: (listener) =>
      vscode.debug.onDidTerminateDebugSession(listener),
    onDidChangeBreakpoints: (listener) => vscode.debug.onDidChangeBreakpoints(listener),
    registerDebugAdapterTrackerFactory: (debugType, factory) =>
      vscode.debug.registerDebugAdapterTrackerFactory(debugType, factory),
    registerExternalClientCommands: () => createVscodeExternalClientCommands(context),
    createBridgeHost: (handler) => new BridgeHost({ handler }),
    async createLiveHostRegistrationPublisher(descriptor) {
      const executable = context.asAbsolutePath(path.join("dist", "mcp-bridge.exe"));
      const bridgeSha256 = await verifyPackagedBridgeIntegrity(
        context.asAbsolutePath(path.join("dist", "runtime-inventory.json")),
        executable,
      );
      return new LiveHostRegistrationPublisher({
        localAppData: process.env.LOCALAPPDATA ?? "",
        ownerPid: process.pid,
        extensionRoot: context.extensionUri.fsPath,
        bridgeExecutable: executable,
        bridgeVersion: version,
        bridgeSha256,
        descriptor,
        workspace: () => ({
          trusted: vscode.workspace.isTrusted,
          roots: (vscode.workspace.workspaceFolders ?? []).map(
            (folder) => folder.uri.fsPath,
          ),
        }),
      });
    },
    registerMcpProvider: (id, provider) =>
      vscode.lm.registerMcpServerDefinitionProvider(id, provider),
  };
}

function readVersion(context: vscode.ExtensionContext): string {
  const value = (context.extension.packageJSON as Record<string, unknown>).version;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("The companion extension manifest version is invalid.");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnitySession(session: vscode.DebugSession): boolean {
  try {
    return session.type === DEBUG_TYPE &&
      typeof session.id === "string" &&
      session.id.length > 0;
  } catch {
    return false;
  }
}
