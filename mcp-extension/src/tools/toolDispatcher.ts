import path from "node:path";
import type * as vscode from "vscode";

import type { ToolName } from "../bridge/protocol.js";
import type {
  BreakpointView,
  OwnedBreakpoint,
} from "../debug/breakpointRegistry.js";
import type { SessionCommandQueue } from "../debug/commandQueue.js";
import {
  DapGateway,
  type DapEvaluation,
  type DapScope,
  type DapStackFrame,
  type DapThread,
  type DapVariable,
} from "../debug/dapGateway.js";
import type {
  EventBuffer,
  NormalizedEventKind,
} from "../debug/eventBuffer.js";
import { ReferenceStore } from "../debug/referenceStore.js";
import type {
  SessionRegistry,
  SessionSelection,
} from "../debug/sessionRegistry.js";
import type { DebugSessionState } from "../debug/stateProjector.js";
import type {
  PublicEditorTarget,
  StartedDebugSession,
} from "../dependencyAdapter.js";
import {
  ambiguousTargetError,
  attachFailedError,
  cancelledError,
  noTargetError,
  notAttachedError,
  notStoppedError,
  reloadingError,
  sanitizedToolError,
  sideEffectsNotAllowedError,
  staleReferenceError,
  targetWorkspaceNotAllowedError,
  workspaceUntrustedError,
} from "./errors.js";
import {
  ADD_BREAKPOINT_INPUT_SCHEMA,
  ATTACH_INPUT_SCHEMA,
  CONTINUE_INPUT_SCHEMA,
  DISCONNECT_INPUT_SCHEMA,
  EVALUATE_EXPLICIT_INPUT_SCHEMA,
  EVALUATE_SAFE_INPUT_SCHEMA,
  LIST_BREAKPOINTS_INPUT_SCHEMA,
  LIST_TARGETS_INPUT_SCHEMA,
  PAUSE_INPUT_SCHEMA,
  REMOVE_BREAKPOINT_INPUT_SCHEMA,
  SCOPES_INPUT_SCHEMA,
  SET_EXCEPTION_BREAKPOINTS_INPUT_SCHEMA,
  SNAPSHOT_INPUT_SCHEMA,
  STACK_TRACE_INPUT_SCHEMA,
  STATUS_INPUT_SCHEMA,
  STEP_INPUT_SCHEMA,
  THREADS_INPUT_SCHEMA,
  VARIABLES_INPUT_SCHEMA,
  WAIT_FOR_EVENT_INPUT_SCHEMA,
  type AddBreakpointInput,
  type EvaluateExplicitInput,
  type EvaluateSafeInput,
  type ExceptionBreakpointMode,
  type ScopesInput,
  type StackTraceInput,
  type StepInput,
  type VariablesInput,
  type WaitForEventInput,
} from "./schemas.js";

const DEFAULT_CLIENT_ID = "default";
const TARGET_CAPABILITY_TTL_MS = 60_000;
const ATTACH_QUEUE_KEY = "\0unity-debugger-pure-mcp/attach";

interface TargetCapabilities {
  readonly expiresAt: number;
  readonly byTargetId: Map<string, PublicEditorTarget>;
}

interface ClientState {
  active: boolean;
  selectionRef?: string;
  targets?: TargetCapabilities;
  targetOperation?: object;
}

interface ObservedSessionState {
  readonly phase: DebugSessionState["phase"];
  readonly stopGeneration: number;
}

interface ControlTransition extends ObservedSessionState {
  readonly token: object;
}

interface StoppedContext {
  readonly selection: SessionSelection;
  readonly session: vscode.DebugSession;
  readonly state: DebugSessionState;
}

export interface ToolDependency {
  discoverTargets(
    workspaceRoots: readonly string[],
  ): Promise<readonly PublicEditorTarget[]>;
  startAttach(targetId: string): Promise<StartedDebugSession>;
}

export interface BreakpointTools {
  list(workspaceRoots: readonly string[]): readonly BreakpointView[];
  add(
    input: AddBreakpointInput,
    workspaceRoots: readonly string[],
  ): OwnedBreakpoint;
  remove(breakpointRef: string): void;
}

export interface WorkspaceTools {
  isTrusted(): boolean;
  roots(): readonly string[];
}

export interface DebugTools {
  stopDebugging(session: vscode.DebugSession): PromiseLike<void>;
}

export interface ToolDispatcherOptions {
  readonly dependency: ToolDependency;
  readonly sessions: SessionRegistry;
  readonly queue: SessionCommandQueue;
  readonly breakpoints: BreakpointTools;
  readonly workspace: WorkspaceTools;
  readonly debug: DebugTools;
  readonly stateForSession: (
    session: vscode.DebugSession,
  ) => DebugSessionState | undefined;
  readonly references?: ReferenceStore;
  readonly dap?: DapGateway;
  readonly eventsForSession?: (sessionRef: string) => EventBuffer | undefined;
  readonly now?: () => number;
}

export interface AttachedStatus {
  readonly session: SessionSelection;
  readonly state: DebugSessionState["phase"];
  readonly stopGeneration: number;
  readonly eventSequence: number;
}

export interface NotAttachedStatus {
  readonly session: null;
  readonly state: "not-attached";
  readonly eventSequence: 0;
}

export class ToolDispatcher {
  readonly #dependency: ToolDependency;
  readonly #sessions: SessionRegistry;
  readonly #queue: SessionCommandQueue;
  readonly #breakpoints: BreakpointTools;
  readonly #workspace: WorkspaceTools;
  readonly #debug: DebugTools;
  readonly #stateForSession: (
    session: vscode.DebugSession,
  ) => DebugSessionState | undefined;
  readonly #references: ReferenceStore;
  readonly #dap: DapGateway;
  readonly #eventsForSession: (sessionRef: string) => EventBuffer | undefined;
  readonly #now: () => number;
  readonly #clients = new Map<string, ClientState>();
  readonly #observedStates = new Map<string, ObservedSessionState>();
  readonly #controlTransitions = new Map<string, ControlTransition>();

  public constructor(options: ToolDispatcherOptions) {
    this.#dependency = options.dependency;
    this.#sessions = options.sessions;
    this.#queue = options.queue;
    this.#breakpoints = options.breakpoints;
    this.#workspace = options.workspace;
    this.#debug = options.debug;
    this.#stateForSession = options.stateForSession;
    this.#references = options.references ?? new ReferenceStore();
    this.#dap = options.dap ?? new DapGateway();
    this.#eventsForSession = options.eventsForSession ?? (() => undefined);
    this.#now = options.now ?? Date.now;
  }

  public async call(
    name: ToolName,
    input: unknown,
    clientId = DEFAULT_CLIENT_ID,
    signal?: AbortSignal,
  ): Promise<unknown> {
    try {
      if (signal?.aborted === true) {
        throw cancelledError();
      }
      if (!this.#workspace.isTrusted()) {
        throw workspaceUntrustedError();
      }

      switch (name) {
        case "unity_debug_list_targets":
          LIST_TARGETS_INPUT_SCHEMA.parse(input);
          return await this.#listTargets(clientId, signal);
        case "unity_debug_attach":
          return await this.#attach(
            ATTACH_INPUT_SCHEMA.parse(input),
            clientId,
            signal,
          );
        case "unity_debug_status":
          return this.#status(STATUS_INPUT_SCHEMA.parse(input), clientId);
        case "unity_debug_disconnect":
          return await this.#disconnect(
            DISCONNECT_INPUT_SCHEMA.parse(input),
            clientId,
            signal,
          );
        case "unity_debug_list_breakpoints":
          LIST_BREAKPOINTS_INPUT_SCHEMA.parse(input);
          return Object.freeze({
            breakpoints: this.#breakpoints.list(this.#workspaceRoots()),
          });
        case "unity_debug_add_breakpoint": {
          const parsed = ADD_BREAKPOINT_INPUT_SCHEMA.parse(input);
          return Object.freeze({
            breakpoint: this.#breakpoints.add(parsed, this.#workspaceRoots()),
          });
        }
        case "unity_debug_remove_breakpoint": {
          const parsed = REMOVE_BREAKPOINT_INPUT_SCHEMA.parse(input);
          this.#breakpoints.remove(parsed.breakpointRef);
          return Object.freeze({
            breakpointRef: parsed.breakpointRef,
            removed: true,
          });
        }
        case "unity_debug_set_exception_breakpoints":
          return await this.#setExceptionBreakpoints(
            SET_EXCEPTION_BREAKPOINTS_INPUT_SCHEMA.parse(input),
            clientId,
            signal,
          );
        case "unity_debug_threads":
          return await this.#threads(
            THREADS_INPUT_SCHEMA.parse(input),
            clientId,
            signal,
          );
        case "unity_debug_stack_trace":
          return await this.#stackTrace(
            STACK_TRACE_INPUT_SCHEMA.parse(input),
            clientId,
            signal,
          );
        case "unity_debug_scopes":
          return await this.#scopes(
            SCOPES_INPUT_SCHEMA.parse(input),
            clientId,
            signal,
          );
        case "unity_debug_variables":
          return await this.#variables(
            VARIABLES_INPUT_SCHEMA.parse(input),
            clientId,
            signal,
          );
        case "unity_debug_snapshot":
          return await this.#snapshot(
            SNAPSHOT_INPUT_SCHEMA.parse(input),
            clientId,
            signal,
          );
        case "unity_debug_evaluate_safe":
          return await this.#evaluate(
            EVALUATE_SAFE_INPUT_SCHEMA.parse(input),
            false,
            clientId,
            signal,
          );
        case "unity_debug_evaluate_explicit":
          assertExplicitConsent(input);
          return await this.#evaluate(
            EVALUATE_EXPLICIT_INPUT_SCHEMA.parse(input),
            true,
            clientId,
            signal,
          );
        case "unity_debug_pause":
          return await this.#pause(
            PAUSE_INPUT_SCHEMA.parse(input),
            clientId,
            signal,
          );
        case "unity_debug_continue":
          return await this.#resume(
            CONTINUE_INPUT_SCHEMA.parse(input),
            "continue",
            clientId,
            signal,
          );
        case "unity_debug_step": {
          const parsed = STEP_INPUT_SCHEMA.parse(input);
          return await this.#resume(parsed, parsed.kind, clientId, signal);
        }
        case "unity_debug_wait_for_event":
          return await this.#waitForEvent(
            WAIT_FOR_EVENT_INPUT_SCHEMA.parse(input),
            clientId,
            signal,
          );
        default:
          throw new Error("Tool implementation is not available.");
      }
    } catch (error) {
      throw sanitizedToolError(error);
    }
  }

  public onDisconnect(clientId: string): void {
    const state = this.#clients.get(clientId);
    if (state !== undefined) {
      state.active = false;
      state.selectionRef = undefined;
      state.targets = undefined;
      state.targetOperation = undefined;
      this.#clients.delete(clientId);
    }
  }

  /** Composition hook for tracker state events and session removal. */
  public onSessionStateChanged(sessionRef: string): void {
    try {
      const selection = this.#sessions.select(sessionRef);
      const session = this.#sessions.resolveDebugSession(selection);
      this.#syncState(selection.sessionRef, this.#currentState(session));
    } catch {
      this.#references.invalidate(sessionRef);
      this.#observedStates.delete(sessionRef);
      this.#controlTransitions.delete(sessionRef);
    }
  }

  async #listTargets(
    clientId: string,
    signal?: AbortSignal,
  ): Promise<Readonly<{ targets: readonly PublicEditorTarget[] }>> {
    const client = this.#clientState(clientId);
    const operation = {};
    client.targets = undefined;
    client.targetOperation = operation;
    const issuedAt = this.#now();
    const requestedRoots = this.#workspaceRoots();
    const requestedRootMap = workspaceRootMap(requestedRoots);
    const discovered = await this.#dependency.discoverTargets(requestedRoots);
    if (
      signal?.aborted === true ||
      !this.#isCurrentClient(clientId, client) ||
      client.targetOperation !== operation
    ) {
      throw cancelledError();
    }
    if (!this.#workspace.isTrusted()) {
      throw workspaceUntrustedError();
    }
    const freshRootMap = workspaceRootMap(this.#workspaceRoots());
    const capabilities = new Map<string, PublicEditorTarget>();
    const targets: PublicEditorTarget[] = [];
    for (const target of discovered) {
      const workspaceRootKey = canonicalPathKey(target.workspaceRoot);
      if (!requestedRootMap.has(workspaceRootKey)) {
        continue;
      }
      const currentWorkspaceRoot = freshRootMap.get(workspaceRootKey);
      if (currentWorkspaceRoot === undefined) {
        continue;
      }
      const safeTarget = safeTargetView(target, currentWorkspaceRoot);
      if (capabilities.has(safeTarget.targetId)) {
        throw new Error("Debugger dependency returned duplicate target references.");
      }
      capabilities.set(safeTarget.targetId, safeTarget);
      targets.push(safeTarget);
    }
    client.targets = {
      expiresAt: issuedAt + TARGET_CAPABILITY_TTL_MS,
      byTargetId: capabilities,
    };
    client.targetOperation = undefined;
    return Object.freeze({ targets: Object.freeze(targets) });
  }

  async #attach(
    input: Readonly<{ targetId: string }>,
    clientId: string,
    signal?: AbortSignal,
  ): Promise<Readonly<AttachedStatus & { readonly reused: boolean }>> {
    const client = this.#clientState(clientId);
    this.#assertRequestAuthorized(clientId, client, signal);
    const capabilities = client.targets;
    if (capabilities !== undefined && capabilities.expiresAt <= this.#now()) {
      client.targets = undefined;
    }
    const target = client.targets?.byTargetId.get(input.targetId);
    if (target === undefined) {
      throw noTargetError();
    }
    // Target IDs are capabilities issued by list_targets. Consume before any
    // reuse or start attempt so retries must rediscover current state.
    client.targets!.byTargetId.delete(input.targetId);

    return this.#queue.write(ATTACH_QUEUE_KEY, async () =>
      this.#attachUnderGate(
        input.targetId,
        target,
        capabilities!.expiresAt,
        clientId,
        client,
        signal,
      )
    );
  }

  async #attachUnderGate(
    targetId: string,
    target: PublicEditorTarget,
    expiresAt: number,
    clientId: string,
    client: ClientState,
    signal?: AbortSignal,
  ): Promise<Readonly<AttachedStatus & { readonly reused: boolean }>> {
    this.#assertRequestAuthorized(clientId, client, signal);
    if (expiresAt <= this.#now()) {
      throw noTargetError();
    }

    const currentWorkspaceRoot = this.#currentTargetWorkspaceRoot(
      target.workspaceRoot,
    );

    const matching = this.#matchingTrackedSessions(currentWorkspaceRoot);
    if (matching.length > 1) {
      throw ambiguousTargetError();
    }

    let selection: SessionSelection;
    let reused: boolean;
    if (matching.length === 1) {
      selection = matching[0];
      reused = true;
    } else {
      this.#assertRequestAuthorized(clientId, client, signal);
      const started = await this.#dependency.startAttach(targetId);
      this.#assertRequestAuthorized(clientId, client, signal);
      this.#currentTargetWorkspaceRoot(target.workspaceRoot);
      const registered = this.#sessions.findBySessionId(started.sessionId);
      if (registered === undefined || !registered.tracked) {
        throw attachFailedError();
      }
      // Resolve once now to ensure the API result still names a live entry.
      this.#sessions.resolveDebugSession(registered);
      selection = registered;
      reused = false;
    }

    const status = this.#attachedStatus(selection);
    this.#assertRequestAuthorized(clientId, client, signal);
    client.selectionRef = selection.sessionRef;
    return Object.freeze({
      ...status,
      reused,
    });
  }

  #status(
    input: Readonly<{ sessionRef?: string }>,
    clientId: string,
  ): AttachedStatus | NotAttachedStatus {
    if (input.sessionRef !== undefined) {
      return this.#attachedStatus(this.#sessions.select(input.sessionRef));
    }
    const client = this.#clients.get(clientId);
    const cached = client?.selectionRef;
    if (cached === undefined) {
      return notAttachedStatus();
    }
    let selection: SessionSelection;
    try {
      selection = this.#sessions.select(cached);
    } catch {
      if (client !== undefined) {
        client.selectionRef = undefined;
      }
      return notAttachedStatus();
    }
    return this.#attachedStatus(selection);
  }

  async #disconnect(
    input: Readonly<{ sessionRef?: string; terminateSession: boolean }>,
    clientId: string,
    signal?: AbortSignal,
  ): Promise<Readonly<{
    sessionRef: string;
    terminated: boolean;
  }>> {
    const client = this.#clientState(clientId);
    this.#assertRequestAuthorized(clientId, client, signal);
    const selection = this.#requiredSelection(input.sessionRef, clientId);
    if (!input.terminateSession) {
      this.#sessions.resolveDebugSession(selection);
      if (client.selectionRef === selection.sessionRef) {
        client.selectionRef = undefined;
      }
      return Object.freeze({
        sessionRef: selection.sessionRef,
        terminated: false,
      });
    }

    return this.#queue.write(selection.sessionRef, async () => {
      this.#assertRequestAuthorized(clientId, client, signal);
      const current = this.#sessions.select(selection.sessionRef);
      const liveSession = this.#sessions.resolveDebugSession(current);
      this.#assertRequestAuthorized(clientId, client, signal);
      await this.#debug.stopDebugging(liveSession);
      if (
        this.#isCurrentClient(clientId, client) &&
        client.selectionRef === selection.sessionRef
      ) {
        client.selectionRef = undefined;
      }
      return Object.freeze({
        sessionRef: selection.sessionRef,
        terminated: true,
      });
    });
  }

  async #setExceptionBreakpoints(
    input: Readonly<{
      sessionRef?: string;
      mode: ExceptionBreakpointMode;
    }>,
    clientId: string,
    signal?: AbortSignal,
  ): Promise<Readonly<{ sessionRef: string; mode: ExceptionBreakpointMode }>> {
    const client = this.#clientState(clientId);
    this.#assertRequestAuthorized(clientId, client, signal);
    const selection = this.#requiredSelection(input.sessionRef, clientId);
    const filters = input.mode === "none" ? [] : [input.mode];

    await this.#queue.write(selection.sessionRef, async () => {
      this.#assertRequestAuthorized(clientId, client, signal);
      // The queue may have waited behind another command; resolve again at the
      // point of use instead of trusting an earlier DebugSession object.
      const current = this.#sessions.select(selection.sessionRef);
      const liveSession = this.#sessions.resolveDebugSession(current);
      this.#assertRequestAuthorized(clientId, client, signal);
      await liveSession.customRequest("setExceptionBreakpoints", { filters });
    });

    return Object.freeze({
      sessionRef: selection.sessionRef,
      mode: input.mode,
    });
  }

  async #threads(
    input: Readonly<{ sessionRef?: string }>,
    clientId: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const client = this.#clientState(clientId);
    this.#assertRequestAuthorized(clientId, client, signal);
    const selection = this.#trackedSelection(input.sessionRef, clientId);
    return this.#queue.read(selection.sessionRef, async () => {
      this.#assertRequestAuthorized(clientId, client, signal);
      const context = this.#stoppedContext(selection.sessionRef);
      const threads = await this.#dap.threads(context.session);
      this.#assertRequestAuthorized(clientId, client, signal);
      this.#recheckStopped(context);
      return Object.freeze({
        sessionRef: selection.sessionRef,
        stopGeneration: context.state.stopGeneration,
        threads: Object.freeze(threads.map((thread) => this.#threadView(
          selection.sessionRef,
          context.state.stopGeneration,
          thread,
        ))),
      });
    });
  }

  async #stackTrace(
    input: StackTraceInput,
    clientId: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const client = this.#clientState(clientId);
    this.#assertRequestAuthorized(clientId, client, signal);
    const selection = this.#trackedSelection(input.sessionRef, clientId);
    return this.#queue.read(selection.sessionRef, async () => {
      this.#assertRequestAuthorized(clientId, client, signal);
      const context = this.#stoppedContext(selection.sessionRef);
      const threadId = this.#references.resolve<number>(
        input.threadRef,
        selection.sessionRef,
        context.state.stopGeneration,
        "thread",
      );
      const stack = await this.#dap.stackTrace(
        context.session,
        threadId,
        input.startFrame,
        input.levels,
      );
      this.#assertRequestAuthorized(clientId, client, signal);
      this.#recheckStopped(context);
      const frames = stack.stackFrames.slice(0, input.levels);
      return Object.freeze({
        sessionRef: selection.sessionRef,
        stopGeneration: context.state.stopGeneration,
        totalFrames: stack.totalFrames ?? frames.length,
        frames: Object.freeze(frames.map((frame) => this.#frameView(
          selection.sessionRef,
          context.state.stopGeneration,
          frame,
        ))),
      });
    });
  }

  async #scopes(
    input: ScopesInput,
    clientId: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const client = this.#clientState(clientId);
    this.#assertRequestAuthorized(clientId, client, signal);
    const selection = this.#trackedSelection(input.sessionRef, clientId);
    return this.#queue.read(selection.sessionRef, async () => {
      this.#assertRequestAuthorized(clientId, client, signal);
      const context = this.#stoppedContext(selection.sessionRef);
      const frameId = this.#references.resolve<number>(
        input.frameRef,
        selection.sessionRef,
        context.state.stopGeneration,
        "frame",
      );
      const scopes = await this.#dap.scopes(context.session, frameId);
      this.#assertRequestAuthorized(clientId, client, signal);
      this.#recheckStopped(context);
      return Object.freeze({
        sessionRef: selection.sessionRef,
        stopGeneration: context.state.stopGeneration,
        scopes: Object.freeze(scopes.map((scope) => this.#scopeView(
          selection.sessionRef,
          context.state.stopGeneration,
          scope,
        ))),
      });
    });
  }

  async #variables(
    input: VariablesInput,
    clientId: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const client = this.#clientState(clientId);
    this.#assertRequestAuthorized(clientId, client, signal);
    const selection = this.#trackedSelection(input.sessionRef, clientId);
    return this.#queue.read(selection.sessionRef, async () => {
      this.#assertRequestAuthorized(clientId, client, signal);
      const context = this.#stoppedContext(selection.sessionRef);
      const variablesReference = this.#resolveVariablesReference(
        input.variablesRef,
        selection.sessionRef,
        context.state.stopGeneration,
      );
      const variables = await this.#dap.variables(
        context.session,
        variablesReference,
        input.start,
        input.count,
      );
      this.#assertRequestAuthorized(clientId, client, signal);
      this.#recheckStopped(context);
      return Object.freeze({
        sessionRef: selection.sessionRef,
        stopGeneration: context.state.stopGeneration,
        variables: Object.freeze(variables.slice(0, input.count).map((variable) =>
          this.#variableView(
            selection.sessionRef,
            context.state.stopGeneration,
            variable,
          )
        )),
      });
    });
  }

  async #snapshot(
    input: Readonly<{ sessionRef?: string }>,
    clientId: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const client = this.#clientState(clientId);
    this.#assertRequestAuthorized(clientId, client, signal);
    const selection = this.#trackedSelection(input.sessionRef, clientId);
    return this.#queue.read(selection.sessionRef, async () => {
      this.#assertRequestAuthorized(clientId, client, signal);
      const context = this.#stoppedContext(selection.sessionRef);
      const threads = await this.#dap.threads(context.session);
      this.#afterInspectionAwait(context, clientId, client, signal);
      const selectedThread = selectStoppedThread(threads, context.state.threadId);
      let frames: readonly DapStackFrame[] = [];
      let scopes: readonly DapScope[] = [];
      let variables: readonly DapVariable[] = [];
      if (selectedThread !== undefined) {
        const stack = await this.#dap.stackTrace(
          context.session,
          selectedThread.id,
          0,
          20,
        );
        this.#afterInspectionAwait(context, clientId, client, signal);
        frames = stack.stackFrames.slice(0, 20);
      }
      if (frames[0] !== undefined) {
        scopes = await this.#dap.scopes(context.session, frames[0].id);
        this.#afterInspectionAwait(context, clientId, client, signal);
      }
      const firstScope = scopes.find((scope) => !scope.expensive);
      if (firstScope !== undefined) {
        variables = await this.#dap.variables(
          context.session,
          firstScope.variablesReference,
          0,
          100,
        );
        this.#afterInspectionAwait(context, clientId, client, signal);
        variables = variables.slice(0, 100);
      }
      // No opaque reference is allocated until every requested DAP operation
      // has succeeded and the generation has passed its final check.
      this.#assertRequestAuthorized(clientId, client, signal);
      this.#recheckStopped(context);
      return Object.freeze({
        sessionRef: selection.sessionRef,
        stopGeneration: context.state.stopGeneration,
        reason: context.state.reason,
        thread: selectedThread === undefined
          ? null
          : this.#threadView(
            selection.sessionRef,
            context.state.stopGeneration,
            selectedThread,
          ),
        frames: Object.freeze(frames.map((frame) => this.#frameView(
          selection.sessionRef,
          context.state.stopGeneration,
          frame,
        ))),
        scopes: Object.freeze(scopes.map((scope) => this.#scopeView(
          selection.sessionRef,
          context.state.stopGeneration,
          scope,
        ))),
        variables: Object.freeze(variables.map((variable) => this.#variableView(
          selection.sessionRef,
          context.state.stopGeneration,
          variable,
        ))),
      });
    });
  }

  async #evaluate(
    input: EvaluateSafeInput | EvaluateExplicitInput,
    explicit: boolean,
    clientId: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const client = this.#clientState(clientId);
    this.#assertRequestAuthorized(clientId, client, signal);
    const selection = this.#trackedSelection(input.sessionRef, clientId);
    const operation = async () => {
      this.#assertRequestAuthorized(clientId, client, signal);
      const context = this.#stoppedContext(selection.sessionRef);
      const frameId = this.#references.resolve<number>(
        input.frameRef,
        selection.sessionRef,
        context.state.stopGeneration,
        "frame",
      );
      const evaluation = explicit
        ? await this.#dap.evaluateExplicit(context.session, frameId, input.expression)
        : await this.#dap.evaluateSafe(context.session, frameId, input.expression);
      this.#assertRequestAuthorized(clientId, client, signal);
      this.#recheckStopped(context);
      return this.#evaluationView(
        selection.sessionRef,
        context.state.stopGeneration,
        evaluation,
      );
    };
    return explicit
      ? this.#queue.write(selection.sessionRef, operation)
      : this.#queue.read(selection.sessionRef, operation);
  }

  async #pause(
    input: Readonly<{ sessionRef?: string }>,
    clientId: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const client = this.#clientState(clientId);
    this.#assertRequestAuthorized(clientId, client, signal);
    const selection = this.#trackedSelection(input.sessionRef, clientId);
    return this.#queue.write(selection.sessionRef, async () => {
      this.#assertRequestAuthorized(clientId, client, signal);
      const session = this.#sessions.resolveDebugSession(
        this.#sessions.selectForInspection(selection.sessionRef),
      );
      const state = this.#currentState(session);
      this.#syncState(selection.sessionRef, state);
      this.#assertControlPhase(selection.sessionRef, state, "running");
      const threads = await this.#dap.threads(session);
      this.#assertRequestAuthorized(clientId, client, signal);
      this.#recheckControlState(selection.sessionRef, session, state, "running");
      const thread = threads[0];
      if (thread === undefined) {
        throw new Error("Debugger did not return a pausable thread.");
      }
      const transition = this.#beginControlTransition(selection.sessionRef, state);
      try {
        await this.#dap.pause(session, thread.id);
      } catch (error) {
        this.#clearFailedTransition(selection.sessionRef, transition);
        throw error;
      }
      this.#assertRequestAuthorized(clientId, client, signal);
      return Object.freeze({
        sessionRef: selection.sessionRef,
        transitioning: true,
      });
    });
  }

  async #resume(
    input: Readonly<{ sessionRef?: string }>,
    operation: "continue" | "in" | "over" | "out",
    clientId: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const client = this.#clientState(clientId);
    this.#assertRequestAuthorized(clientId, client, signal);
    const selection = this.#trackedSelection(input.sessionRef, clientId);
    return this.#queue.write(selection.sessionRef, async () => {
      this.#assertRequestAuthorized(clientId, client, signal);
      const session = this.#sessions.resolveDebugSession(
        this.#sessions.selectForInspection(selection.sessionRef),
      );
      const state = this.#currentState(session);
      this.#syncState(selection.sessionRef, state);
      this.#assertControlPhase(selection.sessionRef, state, "stopped");
      let threadId = validPositiveHandle(state.threadId) ? state.threadId : undefined;
      if (threadId === undefined) {
        const threads = await this.#dap.threads(session);
        this.#assertRequestAuthorized(clientId, client, signal);
        this.#recheckControlState(selection.sessionRef, session, state, "stopped");
        threadId = threads[0]?.id;
      }
      if (threadId === undefined) {
        throw new Error("Debugger did not return a resumable thread.");
      }
      this.#assertRequestAuthorized(clientId, client, signal);
      this.#recheckControlState(selection.sessionRef, session, state, "stopped");
      const transition = this.#beginControlTransition(selection.sessionRef, state);
      this.#references.invalidate(selection.sessionRef);
      try {
        if (operation === "continue") {
          await this.#dap.continue(session, threadId);
        } else if (operation === "in") {
          await this.#dap.stepIn(session, threadId);
        } else if (operation === "over") {
          await this.#dap.next(session, threadId);
        } else {
          await this.#dap.stepOut(session, threadId);
        }
      } catch (error) {
        this.#clearFailedTransition(selection.sessionRef, transition);
        throw error;
      }
      this.#assertRequestAuthorized(clientId, client, signal);
      const result: { sessionRef: string; transitioning: true; kind?: string } = {
        sessionRef: selection.sessionRef,
        transitioning: true,
      };
      if (operation !== "continue") {
        result.kind = operation;
      }
      return Object.freeze(result);
    });
  }

  async #waitForEvent(
    input: WaitForEventInput,
    clientId: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const client = this.#clientState(clientId);
    this.#assertRequestAuthorized(clientId, client, signal);
    const selection = this.#trackedSelection(input.sessionRef, clientId);
    const session = this.#sessions.resolveDebugSession(selection);
    this.#syncState(selection.sessionRef, this.#currentState(session));
    const buffer = this.#eventsForSession(selection.sessionRef);
    if (buffer === undefined) {
      throw notAttachedError();
    }
    const event = await buffer.waitFor(
      input.afterSequence,
      input.kinds as readonly NormalizedEventKind[] | undefined,
      input.timeoutMs,
      signal,
    );
    this.#assertRequestAuthorized(clientId, client, signal);
    this.#sessions.resolveDebugSession(this.#sessions.selectForInspection(selection.sessionRef));
    return Object.freeze({
      sessionRef: selection.sessionRef,
      event,
    });
  }

  #trackedSelection(
    explicitSessionRef: string | undefined,
    clientId: string,
  ): SessionSelection {
    const selected = this.#requiredSelection(explicitSessionRef, clientId);
    return this.#sessions.selectForInspection(selected.sessionRef);
  }

  #currentState(session: vscode.DebugSession): DebugSessionState {
    return this.#stateForSession(session) ?? Object.freeze({
      phase: "starting",
      stopGeneration: 0,
      eventSequence: 0,
    });
  }

  #syncState(sessionRef: string, state: DebugSessionState): void {
    const previous = this.#observedStates.get(sessionRef);
    if (
      previous !== undefined &&
      (previous.phase !== state.phase ||
        previous.stopGeneration !== state.stopGeneration)
    ) {
      this.#references.invalidate(sessionRef);
    }
    this.#observedStates.set(sessionRef, Object.freeze({
      phase: state.phase,
      stopGeneration: state.stopGeneration,
    }));
    const transition = this.#controlTransitions.get(sessionRef);
    if (
      transition !== undefined &&
      (transition.phase !== state.phase ||
        transition.stopGeneration !== state.stopGeneration)
    ) {
      this.#controlTransitions.delete(sessionRef);
    }
  }

  #stoppedContext(sessionRef: string): StoppedContext {
    const selection = this.#sessions.selectForInspection(sessionRef);
    const session = this.#sessions.resolveDebugSession(selection);
    const state = this.#currentState(session);
    this.#syncState(sessionRef, state);
    this.#assertInspectableState(sessionRef, state);
    return Object.freeze({ selection, session, state });
  }

  #assertInspectableState(sessionRef: string, state: DebugSessionState): void {
    if (state.phase === "terminated") {
      throw notAttachedError();
    }
    if (state.phase === "reloading") {
      throw reloadingError();
    }
    if (
      state.phase !== "stopped" ||
      this.#controlTransitions.has(sessionRef)
    ) {
      throw notStoppedError();
    }
  }

  #recheckStopped(expected: StoppedContext): void {
    let currentSession: vscode.DebugSession;
    try {
      const currentSelection = this.#sessions.selectForInspection(
        expected.selection.sessionRef,
      );
      currentSession = this.#sessions.resolveDebugSession(currentSelection);
    } catch {
      this.#references.invalidate(expected.selection.sessionRef);
      throw staleReferenceError();
    }
    const currentState = this.#currentState(currentSession);
    this.#syncState(expected.selection.sessionRef, currentState);
    if (
      currentSession !== expected.session ||
      currentState.phase !== expected.state.phase ||
      currentState.stopGeneration !== expected.state.stopGeneration ||
      this.#controlTransitions.has(expected.selection.sessionRef)
    ) {
      this.#references.invalidate(expected.selection.sessionRef);
      throw staleReferenceError();
    }
    this.#assertInspectableState(expected.selection.sessionRef, currentState);
  }

  #afterInspectionAwait(
    context: StoppedContext,
    clientId: string,
    client: ClientState,
    signal?: AbortSignal,
  ): void {
    this.#assertRequestAuthorized(clientId, client, signal);
    this.#recheckStopped(context);
  }

  #assertControlPhase(
    sessionRef: string,
    state: DebugSessionState,
    expected: "running" | "stopped",
  ): void {
    if (state.phase === "terminated") {
      throw notAttachedError();
    }
    if (state.phase === "reloading") {
      throw reloadingError();
    }
    if (state.phase !== expected || this.#controlTransitions.has(sessionRef)) {
      throw notStoppedError();
    }
  }

  #recheckControlState(
    sessionRef: string,
    session: vscode.DebugSession,
    expected: DebugSessionState,
    phase: "running" | "stopped",
  ): void {
    const currentSelection = this.#sessions.selectForInspection(sessionRef);
    const currentSession = this.#sessions.resolveDebugSession(currentSelection);
    const current = this.#currentState(currentSession);
    this.#syncState(sessionRef, current);
    if (
      currentSession !== session ||
      current.phase !== expected.phase ||
      current.stopGeneration !== expected.stopGeneration
    ) {
      throw staleReferenceError();
    }
    this.#assertControlPhase(sessionRef, current, phase);
  }

  #beginControlTransition(
    sessionRef: string,
    state: DebugSessionState,
  ): ControlTransition {
    const transition = Object.freeze({
      phase: state.phase,
      stopGeneration: state.stopGeneration,
      token: {},
    });
    this.#controlTransitions.set(sessionRef, transition);
    return transition;
  }

  #clearFailedTransition(
    sessionRef: string,
    transition: ControlTransition,
  ): void {
    if (this.#controlTransitions.get(sessionRef) === transition) {
      this.#controlTransitions.delete(sessionRef);
    }
  }

  #resolveVariablesReference(
    variablesRef: string,
    sessionRef: string,
    generation: number,
  ): number {
    try {
      return this.#references.resolve<number>(
        variablesRef,
        sessionRef,
        generation,
        "scope",
      );
    } catch {
      return this.#references.resolve<number>(
        variablesRef,
        sessionRef,
        generation,
        "variable",
      );
    }
  }

  #threadView(
    sessionRef: string,
    generation: number,
    thread: DapThread,
  ): Readonly<Record<string, unknown>> {
    const name = truncateDisplay(thread.name);
    return Object.freeze({
      threadRef: this.#references.create(sessionRef, generation, "thread", thread.id),
      name: name.value,
      ...(name.truncated ? { truncated: true } : {}),
    });
  }

  #frameView(
    sessionRef: string,
    generation: number,
    frame: DapStackFrame,
  ): Readonly<Record<string, unknown>> {
    const name = truncateDisplay(frame.name);
    const result: Record<string, unknown> = {
      frameRef: this.#references.create(sessionRef, generation, "frame", frame.id),
      name: name.value,
      line: frame.line,
    };
    if (frame.column !== undefined) {
      result.column = frame.column;
    }
    if (frame.source?.name !== undefined) {
      result.sourceName = truncateDisplay(frame.source.name).value;
    }
    if (name.truncated) {
      result.truncated = true;
    }
    return Object.freeze(result);
  }

  #scopeView(
    sessionRef: string,
    generation: number,
    scope: DapScope,
  ): Readonly<Record<string, unknown>> {
    const name = truncateDisplay(scope.name);
    return Object.freeze({
      name: name.value,
      expensive: scope.expensive,
      variablesRef: this.#references.create(
        sessionRef,
        generation,
        "scope",
        scope.variablesReference,
      ),
      ...(name.truncated ? { truncated: true } : {}),
    });
  }

  #variableView(
    sessionRef: string,
    generation: number,
    variable: DapVariable,
  ): Readonly<Record<string, unknown>> {
    const name = truncateDisplay(variable.name);
    const value = truncateDisplay(variable.value);
    const result: Record<string, unknown> = {
      name: name.value,
      value: value.value,
    };
    if (variable.type !== undefined) {
      result.type = truncateDisplay(variable.type).value;
    }
    if (variable.variablesReference > 0) {
      result.variablesRef = this.#references.create(
        sessionRef,
        generation,
        "variable",
        variable.variablesReference,
      );
    }
    if (name.truncated || value.truncated) {
      result.truncated = true;
    }
    return Object.freeze(result);
  }

  #evaluationView(
    sessionRef: string,
    generation: number,
    evaluation: DapEvaluation,
  ): Readonly<Record<string, unknown>> {
    const display = truncateDisplay(evaluation.result);
    const result: Record<string, unknown> = {
      sessionRef,
      stopGeneration: generation,
      result: display.value,
    };
    if (evaluation.type !== undefined) {
      result.type = truncateDisplay(evaluation.type).value;
    }
    if (evaluation.variablesReference > 0) {
      result.variablesRef = this.#references.create(
        sessionRef,
        generation,
        "variable",
        evaluation.variablesReference,
      );
    }
    if (display.truncated) {
      result.truncated = true;
    }
    return Object.freeze(result);
  }

  #requiredSelection(
    explicitSessionRef: string | undefined,
    clientId: string,
  ): SessionSelection {
    if (explicitSessionRef !== undefined) {
      return this.#sessions.select(explicitSessionRef);
    }
    const client = this.#clients.get(clientId);
    const cached = client?.selectionRef;
    if (cached === undefined) {
      throw notAttachedError();
    }
    try {
      return this.#sessions.select(cached);
    } catch (error) {
      if (client !== undefined) {
        client.selectionRef = undefined;
      }
      throw error;
    }
  }

  #matchingTrackedSessions(workspaceRoot: string): readonly SessionSelection[] {
    const expected = canonicalPathKey(workspaceRoot);
    const result: SessionSelection[] = [];
    for (const selection of this.#sessions.list()) {
      if (!selection.tracked) {
        continue;
      }
      let session: vscode.DebugSession;
      try {
        session = this.#sessions.resolveDebugSession(selection);
      } catch {
        continue;
      }
      const candidateRoot = session.workspaceFolder?.uri.fsPath;
      if (candidateRoot !== undefined && canonicalPathKey(candidateRoot) === expected) {
        result.push(selection);
      }
    }
    return result;
  }

  #attachedStatus(selection: SessionSelection): AttachedStatus {
    const liveSession = this.#sessions.resolveDebugSession(selection);
    const state = this.#currentState(liveSession);
    this.#syncState(selection.sessionRef, state);
    const phase = this.#controlTransitions.has(selection.sessionRef)
      ? "running" as const
      : state.phase;
    return Object.freeze({
      session: selection,
      state: phase,
      stopGeneration: state.stopGeneration,
      eventSequence: state.eventSequence,
    });
  }

  #workspaceRoots(): readonly string[] {
    const roots = new Map<string, string>();
    for (const workspaceRoot of this.#workspace.roots()) {
      const canonical = path.resolve(workspaceRoot);
      const key = canonicalPathKey(canonical);
      if (!roots.has(key)) {
        roots.set(key, canonical);
      }
    }
    return Object.freeze([...roots.values()]);
  }

  #currentTargetWorkspaceRoot(targetWorkspaceRoot: string): string {
    const current = workspaceRootMap(this.#workspaceRoots()).get(
      canonicalPathKey(targetWorkspaceRoot),
    );
    if (current === undefined) {
      throw targetWorkspaceNotAllowedError();
    }
    return current;
  }

  #clientState(clientId: string): ClientState {
    let state = this.#clients.get(clientId);
    if (state === undefined) {
      state = { active: true };
      this.#clients.set(clientId, state);
    }
    return state;
  }

  #isCurrentClient(clientId: string, state: ClientState): boolean {
    return state.active && this.#clients.get(clientId) === state;
  }

  #assertRequestAuthorized(
    clientId: string,
    state: ClientState,
    signal?: AbortSignal,
  ): void {
    if (signal?.aborted === true || !this.#isCurrentClient(clientId, state)) {
      throw cancelledError();
    }
    if (!this.#workspace.isTrusted()) {
      throw workspaceUntrustedError();
    }
  }
}

function notAttachedStatus(): NotAttachedStatus {
  return Object.freeze({
    session: null,
    state: "not-attached",
    eventSequence: 0,
  });
}

function canonicalPathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function workspaceRootMap(
  workspaceRoots: readonly string[],
): ReadonlyMap<string, string> {
  const roots = new Map<string, string>();
  for (const workspaceRoot of workspaceRoots) {
    const key = canonicalPathKey(workspaceRoot);
    if (!roots.has(key)) {
      roots.set(key, workspaceRoot);
    }
  }
  return roots;
}

function safeTargetView(
  target: PublicEditorTarget,
  workspaceRoot: string,
): PublicEditorTarget {
  return Object.freeze({
    targetId: target.targetId,
    processId: target.processId,
    projectName: target.projectName,
    workspaceRoot,
    projectVersion: target.projectVersion,
    source: target.source,
  });
}

function assertExplicitConsent(input: unknown): void {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    (input as Record<string, unknown>).allowSideEffects !== true
  ) {
    throw sideEffectsNotAllowedError();
  }
}

function selectStoppedThread(
  threads: readonly DapThread[],
  stoppedThreadId: number | undefined,
): DapThread | undefined {
  if (validPositiveHandle(stoppedThreadId)) {
    const selected = threads.find((thread) => thread.id === stoppedThreadId);
    if (selected !== undefined) {
      return selected;
    }
  }
  return threads[0];
}

function validPositiveHandle(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function truncateDisplay(value: string): Readonly<{
  value: string;
  truncated: boolean;
}> {
  if (value.length <= 4_096) {
    return Object.freeze({ value, truncated: false });
  }
  let end = 4_096;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    end -= 1;
  }
  return Object.freeze({
    value: value.slice(0, end),
    truncated: true,
  });
}
