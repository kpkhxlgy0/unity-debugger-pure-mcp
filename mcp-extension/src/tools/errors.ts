import { z } from "zod";

export const TOOL_ERROR_CODES = [
  "BRIDGE_UNAVAILABLE",
  "AMBIGUOUS_BRIDGE",
  "INCOMPATIBLE_DEBUGGER_API",
  "WORKSPACE_NOT_ALLOWED",
  "WORKSPACE_UNTRUSTED",
  "NO_TARGET",
  "AMBIGUOUS_TARGET",
  "TARGET_EXPIRED",
  "ATTACH_FAILED",
  "SESSION_UNTRACKED",
  "NOT_ATTACHED",
  "NOT_STOPPED",
  "STALE_REFERENCE",
  "RELOADING",
  "SIDE_EFFECTS_NOT_ALLOWED",
  "DAP_FAILURE",
  "TIMEOUT",
  "CANCELLED",
] as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

export interface StructuredToolError {
  readonly code: ToolErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly currentState: string;
  readonly action: string;
}

export const TOOL_ERROR_CODE_SCHEMA = z.enum(TOOL_ERROR_CODES);

export const STRUCTURED_TOOL_ERROR_SCHEMA: z.ZodType<StructuredToolError> = z.strictObject({
  code: TOOL_ERROR_CODE_SCHEMA,
  message: z.string(),
  retryable: z.boolean(),
  currentState: z.string(),
  action: z.string(),
});

export function bridgeUnavailableError(): StructuredToolError {
  return {
    code: "BRIDGE_UNAVAILABLE",
    message: "The debugger bridge is unavailable.",
    retryable: true,
    currentState: "disconnected",
    action: "Reconnect to the debugger bridge and retry the request.",
  };
}

export function cancelledError(): StructuredToolError {
  return {
    code: "CANCELLED",
    message: "The debugger request was cancelled.",
    retryable: true,
    currentState: "unchanged",
    action: "Retry the request if it is still needed.",
  };
}

export function dapFailureError(): StructuredToolError {
  return {
    code: "DAP_FAILURE",
    message: "The debugger request failed.",
    retryable: false,
    currentState: "unknown",
    action: "Check debugger status before retrying the request.",
  };
}

export function workspaceUntrustedError(): StructuredToolError {
  return Object.freeze({
    code: "WORKSPACE_UNTRUSTED",
    message: "Trust this workspace before controlling the debugger.",
    retryable: false,
    currentState: "not-attached",
    action: "Use Workspace: Manage Workspace Trust, then retry.",
  });
}

export function workspaceNotAllowedError(): StructuredToolError {
  return Object.freeze({
    code: "WORKSPACE_NOT_ALLOWED",
    message: "The requested debugger resource is outside the current workspace.",
    retryable: false,
    currentState: "workspace_not_allowed",
    action: "Use a source file from the current trusted workspace.",
  });
}

export function targetWorkspaceNotAllowedError(): StructuredToolError {
  return Object.freeze({
    code: "WORKSPACE_NOT_ALLOWED",
    message: "The selected debugger target is outside the current workspace.",
    retryable: false,
    currentState: "workspace_not_allowed",
    action: "List debugger targets again from the current trusted workspace.",
  });
}

export function noTargetError(): StructuredToolError {
  return Object.freeze({
    code: "NO_TARGET",
    message: "No matching Unity debugger target is available.",
    retryable: true,
    currentState: "target_unavailable",
    action: "List debugger targets again and retry with a returned target reference.",
  });
}

export function ambiguousTargetError(): StructuredToolError {
  return Object.freeze({
    code: "AMBIGUOUS_TARGET",
    message: "More than one matching Unity debugger session is attached.",
    retryable: false,
    currentState: "multiple_sessions",
    action: "Disconnect an extra session and retry the attach request.",
  });
}

export function attachFailedError(): StructuredToolError {
  return Object.freeze({
    code: "ATTACH_FAILED",
    message: "The debugger attach request did not create a tracked session.",
    retryable: true,
    currentState: "not_attached",
    action: "Check debugger status, list targets again, and retry the attach request.",
  });
}

export function staleReferenceError(): StructuredToolError {
  return Object.freeze({
    code: "STALE_REFERENCE",
    message: "The debugger reference is stale or invalid.",
    retryable: false,
    currentState: "reference_invalid",
    action: "Request fresh debugger data and retry with its opaque reference.",
  });
}

export function notStoppedError(): StructuredToolError {
  return Object.freeze({
    code: "NOT_STOPPED",
    message: "The debugger session is not stopped at an inspectable generation.",
    retryable: true,
    currentState: "not_stopped",
    action: "Wait for a stopped event, then request fresh debugger data.",
  });
}

export function reloadingError(): StructuredToolError {
  return Object.freeze({
    code: "RELOADING",
    message: "The Unity domain is reloading.",
    retryable: true,
    currentState: "reloading",
    action: "Wait for reload completion before retrying the request.",
  });
}

export function sideEffectsNotAllowedError(): StructuredToolError {
  return Object.freeze({
    code: "SIDE_EFFECTS_NOT_ALLOWED",
    message: "Explicit evaluation requires side-effect consent.",
    retryable: false,
    currentState: "unchanged",
    action: "Set allowSideEffects to literal true only if target execution is intended.",
  });
}

export function notAttachedError(): StructuredToolError {
  return Object.freeze({
    code: "NOT_ATTACHED",
    message: "No matching Unity debugger session is attached.",
    retryable: true,
    currentState: "detached",
    action: "Attach to a debugger target and retry the request.",
  });
}

export function sanitizedToolError(error: unknown): StructuredToolError {
  try {
    const parsed = STRUCTURED_TOOL_ERROR_SCHEMA.safeParse(error);
    if (parsed.success) {
      return Object.freeze(parsed.data);
    }
  } catch {
    // Fall through to one generic error without touching the original again.
  }
  return Object.freeze(dapFailureError());
}
