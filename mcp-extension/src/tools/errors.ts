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
