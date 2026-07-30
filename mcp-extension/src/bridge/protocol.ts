import { z } from "zod";

import {
  STRUCTURED_TOOL_ERROR_SCHEMA,
  TOOL_ERROR_CODES,
  type StructuredToolError,
} from "../tools/errors.js";

export { TOOL_ERROR_CODES };
export type { StructuredToolError, ToolErrorCode } from "../tools/errors.js";

export const BRIDGE_PROTOCOL_VERSION = 1 as const;

export const TOOL_NAMES = [
  "unity_debug_list_targets",
  "unity_debug_attach",
  "unity_debug_status",
  "unity_debug_disconnect",
  "unity_debug_list_breakpoints",
  "unity_debug_add_breakpoint",
  "unity_debug_remove_breakpoint",
  "unity_debug_set_exception_breakpoints",
  "unity_debug_threads",
  "unity_debug_stack_trace",
  "unity_debug_scopes",
  "unity_debug_variables",
  "unity_debug_snapshot",
  "unity_debug_evaluate_safe",
  "unity_debug_evaluate_explicit",
  "unity_debug_pause",
  "unity_debug_continue",
  "unity_debug_step",
  "unity_debug_wait_for_event",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export type ClientFrame =
  | { readonly type: "hello"; readonly protocolVersion: 1; readonly token: string }
  | { readonly type: "cancel"; readonly id: string }
  | {
      readonly type: "request";
      readonly id: string;
      readonly method: "callTool";
      readonly params: { readonly name: ToolName; readonly input: unknown };
    };

export type ServerFrame =
  | { readonly type: "helloAck"; readonly protocolVersion: 1 }
  | { readonly type: "response"; readonly id: string; readonly result: unknown }
  | {
      readonly type: "response";
      readonly id: string;
      readonly error: StructuredToolError;
    };

const HELLO_SCHEMA = z.strictObject({
  type: z.literal("hello"),
  protocolVersion: z.literal(BRIDGE_PROTOCOL_VERSION),
  token: z.string(),
});

const REQUEST_SCHEMA = z.strictObject({
  type: z.literal("request"),
  id: z.string().min(1),
  method: z.literal("callTool"),
  params: z.strictObject({
    name: z.enum(TOOL_NAMES),
    input: z.unknown(),
  }),
});

const CANCEL_SCHEMA = z.strictObject({
  type: z.literal("cancel"),
  id: z.string().min(1),
});

const HELLO_ACK_SCHEMA = z.strictObject({
  type: z.literal("helloAck"),
  protocolVersion: z.literal(BRIDGE_PROTOCOL_VERSION),
});

const RESPONSE_SCHEMA = z.strictObject({
  type: z.literal("response"),
  id: z.string().min(1),
  result: z.unknown().optional(),
  error: STRUCTURED_TOOL_ERROR_SCHEMA.optional(),
}).superRefine((response, context) => {
  if (("result" in response) === ("error" in response)) {
    context.addIssue({
      code: "custom",
      message: "A response must contain exactly one of result or error.",
    });
  }
});

export const CLIENT_FRAME_SCHEMA: z.ZodType<ClientFrame> = z.discriminatedUnion("type", [
  HELLO_SCHEMA,
  CANCEL_SCHEMA,
  REQUEST_SCHEMA,
]);

export const SERVER_FRAME_SCHEMA = z.discriminatedUnion("type", [
  HELLO_ACK_SCHEMA,
  RESPONSE_SCHEMA,
]) as z.ZodType<ServerFrame>;
