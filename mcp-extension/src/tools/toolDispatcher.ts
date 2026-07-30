import path from "node:path";
import type * as vscode from "vscode";

import type { ToolName } from "../bridge/protocol.js";
import type {
  BreakpointView,
  OwnedBreakpoint,
} from "../debug/breakpointRegistry.js";
import type { SessionCommandQueue } from "../debug/commandQueue.js";
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
  sanitizedToolError,
  targetWorkspaceNotAllowedError,
  workspaceUntrustedError,
} from "./errors.js";
import {
  ADD_BREAKPOINT_INPUT_SCHEMA,
  ATTACH_INPUT_SCHEMA,
  DISCONNECT_INPUT_SCHEMA,
  LIST_BREAKPOINTS_INPUT_SCHEMA,
  LIST_TARGETS_INPUT_SCHEMA,
  REMOVE_BREAKPOINT_INPUT_SCHEMA,
  SET_EXCEPTION_BREAKPOINTS_INPUT_SCHEMA,
  STATUS_INPUT_SCHEMA,
  type AddBreakpointInput,
  type ExceptionBreakpointMode,
} from "./schemas.js";

const DEFAULT_CLIENT_ID = "default";
const TARGET_CAPABILITY_TTL_MS = 60_000;

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
  readonly #now: () => number;
  readonly #clients = new Map<string, ClientState>();

  public constructor(options: ToolDispatcherOptions) {
    this.#dependency = options.dependency;
    this.#sessions = options.sessions;
    this.#queue = options.queue;
    this.#breakpoints = options.breakpoints;
    this.#workspace = options.workspace;
    this.#debug = options.debug;
    this.#stateForSession = options.stateForSession;
    this.#now = options.now ?? Date.now;
  }

  public async call(
    name: ToolName,
    input: unknown,
    clientId = DEFAULT_CLIENT_ID,
  ): Promise<unknown> {
    try {
      if (!this.#workspace.isTrusted()) {
        throw workspaceUntrustedError();
      }

      switch (name) {
        case "unity_debug_list_targets":
          LIST_TARGETS_INPUT_SCHEMA.parse(input);
          return await this.#listTargets(clientId);
        case "unity_debug_attach":
          return await this.#attach(ATTACH_INPUT_SCHEMA.parse(input), clientId);
        case "unity_debug_status":
          return this.#status(STATUS_INPUT_SCHEMA.parse(input), clientId);
        case "unity_debug_disconnect":
          return await this.#disconnect(
            DISCONNECT_INPUT_SCHEMA.parse(input),
            clientId,
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

  async #listTargets(clientId: string): Promise<Readonly<{ targets: readonly PublicEditorTarget[] }>> {
    const client = this.#clientState(clientId);
    const operation = {};
    client.targets = undefined;
    client.targetOperation = operation;
    const issuedAt = this.#now();
    const targets = await this.#dependency.discoverTargets(this.#workspaceRoots());
    if (!this.#isCurrentClient(clientId, client) || client.targetOperation !== operation) {
      throw cancelledError();
    }
    const capabilities = new Map<string, PublicEditorTarget>();
    for (const target of targets) {
      if (capabilities.has(target.targetId)) {
        throw new Error("Debugger dependency returned duplicate target references.");
      }
      capabilities.set(target.targetId, target);
    }
    client.targets = {
      expiresAt: issuedAt + TARGET_CAPABILITY_TTL_MS,
      byTargetId: capabilities,
    };
    client.targetOperation = undefined;
    return Object.freeze({ targets });
  }

  async #attach(
    input: Readonly<{ targetId: string }>,
    clientId: string,
  ): Promise<Readonly<AttachedStatus & { readonly reused: boolean }>> {
    const client = this.#clientState(clientId);
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

    const currentRootKeys = new Set(
      this.#workspaceRoots().map((workspaceRoot) => canonicalPathKey(workspaceRoot)),
    );
    if (!currentRootKeys.has(canonicalPathKey(target.workspaceRoot))) {
      throw targetWorkspaceNotAllowedError();
    }

    const matching = this.#matchingTrackedSessions(target.workspaceRoot);
    if (matching.length > 1) {
      throw ambiguousTargetError();
    }

    let selection: SessionSelection;
    let reused: boolean;
    if (matching.length === 1) {
      selection = matching[0];
      reused = true;
    } else {
      const started = await this.#dependency.startAttach(input.targetId);
      if (!this.#isCurrentClient(clientId, client)) {
        throw cancelledError();
      }
      const registered = this.#sessions.findBySessionId(started.sessionId);
      if (registered === undefined || !registered.tracked) {
        throw attachFailedError();
      }
      // Resolve once now to ensure the API result still names a live entry.
      this.#sessions.resolveDebugSession(registered);
      selection = registered;
      reused = false;
    }

    client.selectionRef = selection.sessionRef;
    return Object.freeze({
      ...this.#attachedStatus(selection),
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
  ): Promise<Readonly<{
    sessionRef: string;
    terminated: boolean;
  }>> {
    const selection = this.#requiredSelection(input.sessionRef, clientId);
    const liveSession = this.#sessions.resolveDebugSession(selection);
    const client = this.#clients.get(clientId);
    if (client?.selectionRef === selection.sessionRef) {
      client.selectionRef = undefined;
    }
    if (input.terminateSession) {
      await this.#debug.stopDebugging(liveSession);
    }
    return Object.freeze({
      sessionRef: selection.sessionRef,
      terminated: input.terminateSession,
    });
  }

  async #setExceptionBreakpoints(
    input: Readonly<{
      sessionRef?: string;
      mode: ExceptionBreakpointMode;
    }>,
    clientId: string,
  ): Promise<Readonly<{ sessionRef: string; mode: ExceptionBreakpointMode }>> {
    const selection = this.#requiredSelection(input.sessionRef, clientId);
    const filters = input.mode === "none" ? [] : [input.mode];

    await this.#queue.write(selection.sessionRef, async () => {
      // The queue may have waited behind another command; resolve again at the
      // point of use instead of trusting an earlier DebugSession object.
      const current = this.#sessions.select(selection.sessionRef);
      const liveSession = this.#sessions.resolveDebugSession(current);
      await liveSession.customRequest("setExceptionBreakpoints", { filters });
    });

    return Object.freeze({
      sessionRef: selection.sessionRef,
      mode: input.mode,
    });
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
    const state = this.#stateForSession(liveSession) ?? {
      phase: "starting" as const,
      stopGeneration: 0,
      eventSequence: 0,
    };
    return Object.freeze({
      session: selection,
      state: state.phase,
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
