import {
  dapFailureError,
  type StructuredToolError,
  type ToolErrorCode,
} from "./tools/errors.js";

const DEBUGGER_EXTENSION_ID = "kpk.unity-debugger-pure";
const DEBUG_TYPE = "unity-debugger-pure";

export type PublicTargetSource = "advertisement" | "derived-port";

export interface PublicEditorTarget {
  readonly targetId: string;
  readonly processId: number;
  readonly projectName: string;
  readonly workspaceRoot: string;
  readonly projectVersion: string;
  readonly source: PublicTargetSource;
}

export interface StartedDebugSession {
  readonly sessionId: string;
  readonly targetId: string;
}

export interface UnityDebuggerPureApiV1 {
  readonly apiVersion: 1;
  readonly extensionVersion: string;
  readonly debugType: "unity-debugger-pure";
  discoverTargets(
    workspaceRoots: readonly string[],
  ): Promise<readonly PublicEditorTarget[]>;
  startAttach(targetId: string): Promise<StartedDebugSession>;
}

interface DebuggerExtensionLike {
  activate(): unknown;
}

type ExtensionLookup = (extensionId: string) => DebuggerExtensionLike | undefined;

interface CandidateApi {
  readonly apiVersion: unknown;
  readonly extensionVersion: unknown;
  readonly debugType: unknown;
  readonly discoverTargets: unknown;
  readonly startAttach: unknown;
}

export class DependencyAdapter {
  readonly #getExtension: ExtensionLookup;
  #api: UnityDebuggerPureApiV1 | undefined;
  #activation: Promise<UnityDebuggerPureApiV1> | undefined;

  public constructor(getExtension: ExtensionLookup) {
    this.#getExtension = getExtension;
  }

  public activate(): Promise<UnityDebuggerPureApiV1> {
    if (this.#api !== undefined) {
      return Promise.resolve(this.#api);
    }
    if (this.#activation !== undefined) {
      return this.#activation;
    }

    const activation = this.#activateOnce();
    this.#activation = activation;
    void activation.then(
      (api) => {
        if (this.#activation === activation) {
          this.#api = api;
          this.#activation = undefined;
        }
      },
      () => {
        if (this.#activation === activation) {
          this.#activation = undefined;
        }
      },
    );
    return activation;
  }

  public async discoverTargets(
    workspaceRoots: readonly string[],
  ): Promise<readonly PublicEditorTarget[]> {
    return (await this.activate()).discoverTargets(workspaceRoots);
  }

  public async startAttach(targetId: string): Promise<StartedDebugSession> {
    return (await this.activate()).startAttach(targetId);
  }

  async #activateOnce(): Promise<UnityDebuggerPureApiV1> {
    try {
      const extension = this.#getExtension(DEBUGGER_EXTENSION_ID);
      if (extension === undefined || typeof extension.activate !== "function") {
        throw incompatibleDebuggerApiError();
      }
      const candidate = await extension.activate.call(extension);
      return validatedFacade(candidate);
    } catch {
      throw incompatibleDebuggerApiError();
    }
  }
}

function validatedFacade(value: unknown): UnityDebuggerPureApiV1 {
  if (!isRecord(value)) {
    throw incompatibleDebuggerApiError();
  }
  const candidate = value as unknown as CandidateApi;
  const apiVersion = candidate.apiVersion;
  const debugType = candidate.debugType;
  const extensionVersion = candidate.extensionVersion;
  const discoverTargets = candidate.discoverTargets;
  const startAttach = candidate.startAttach;
  if (
    apiVersion !== 1 ||
    debugType !== DEBUG_TYPE ||
    typeof extensionVersion !== "string" ||
    typeof discoverTargets !== "function" ||
    typeof startAttach !== "function"
  ) {
    throw incompatibleDebuggerApiError();
  }

  const receiver = value;
  return Object.freeze({
    apiVersion: 1 as const,
    extensionVersion,
    debugType: DEBUG_TYPE,
    async discoverTargets(workspaceRoots: readonly string[]) {
      let result: unknown;
      try {
        result = await discoverTargets.call(receiver, workspaceRoots);
      } catch (error) {
        throw publicApiFailure(error);
      }
      try {
        return validateTargets(result);
      } catch {
        throw incompatibleDebuggerApiError();
      }
    },
    async startAttach(targetId: string) {
      let result: unknown;
      try {
        result = await startAttach.call(receiver, targetId);
      } catch (error) {
        throw publicApiFailure(error);
      }
      try {
        return validateStartedSession(result, targetId);
      } catch {
        throw incompatibleDebuggerApiError();
      }
    },
  });
}

function validateTargets(value: unknown): readonly PublicEditorTarget[] {
  if (!Array.isArray(value)) {
    throw incompatibleDebuggerApiError();
  }
  const targets: PublicEditorTarget[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!isRecord(item)) {
      throw incompatibleDebuggerApiError();
    }
    const targetId = item.targetId;
    const processId = item.processId;
    const projectName = item.projectName;
    const workspaceRoot = item.workspaceRoot;
    const projectVersion = item.projectVersion;
    const source = item.source;
    if (
      !isNonEmptyString(targetId) ||
      !Number.isSafeInteger(processId) ||
      (processId as number) <= 0 ||
      !isNonEmptyString(projectName) ||
      !isNonEmptyString(workspaceRoot) ||
      !isNonEmptyString(projectVersion) ||
      (source !== "advertisement" && source !== "derived-port")
    ) {
      throw incompatibleDebuggerApiError();
    }
    targets.push(Object.freeze({
      targetId,
      processId: processId as number,
      projectName,
      workspaceRoot,
      projectVersion,
      source,
    }));
  }
  return Object.freeze(targets);
}

function validateStartedSession(value: unknown, requestedTargetId: string): StartedDebugSession {
  if (!isRecord(value)) {
    throw incompatibleDebuggerApiError();
  }
  const sessionId = value.sessionId;
  const targetId = value.targetId;
  if (
    !isNonEmptyString(sessionId) ||
    targetId !== requestedTargetId
  ) {
    throw incompatibleDebuggerApiError();
  }
  return Object.freeze({ sessionId, targetId: requestedTargetId });
}

function publicApiFailure(error: unknown): StructuredToolError {
  const code = readKnownPublicErrorCode(error);
  switch (code) {
    case "TARGET_EXPIRED":
      return Object.freeze({
        code,
        message: "The selected debugger target is no longer available.",
        retryable: true,
        currentState: "target_unavailable",
        action: "List debugger targets again and retry with a new target reference.",
      });
    case "WORKSPACE_NOT_ALLOWED":
      return Object.freeze({
        code,
        message: "The debugger target is outside the allowed workspace.",
        retryable: false,
        currentState: "workspace_not_allowed",
        action: "Use a debugger target from the current trusted workspace.",
      });
    case "ATTACH_FAILED":
      return Object.freeze({
        code,
        message: "The debugger attach request failed.",
        retryable: true,
        currentState: "not_attached",
        action: "Check debugger status, list targets again, and retry the attach request.",
      });
    default:
      return Object.freeze(dapFailureError());
  }
}

function readKnownPublicErrorCode(error: unknown): ToolErrorCode | undefined {
  try {
    if (!isRecord(error)) {
      return undefined;
    }
    const code = error.code;
    if (
      code === "TARGET_EXPIRED" ||
      code === "WORKSPACE_NOT_ALLOWED" ||
      code === "ATTACH_FAILED"
    ) {
      return code;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function incompatibleDebuggerApiError(): StructuredToolError {
  return Object.freeze({
    code: "INCOMPATIBLE_DEBUGGER_API",
    message: "The Unity debugger extension API is unavailable or incompatible.",
    retryable: false,
    currentState: "dependency_unavailable",
    action: "Install or update kpk.unity-debugger-pure and retry the request.",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
