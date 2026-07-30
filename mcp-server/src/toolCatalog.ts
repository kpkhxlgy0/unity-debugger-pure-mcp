import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  CallToolResult,
  JSONRPCMessage,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  TOOL_NAMES,
  type ToolName,
} from "../../mcp-extension/src/bridge/protocol.js";
import {
  ADD_BREAKPOINT_INPUT_SCHEMA,
  ATTACH_INPUT_SCHEMA,
  BREAKPOINT_REF_SCHEMA,
  CONTINUE_INPUT_SCHEMA,
  DISCONNECT_INPUT_SCHEMA,
  EVALUATE_EXPLICIT_INPUT_SCHEMA,
  EVALUATE_SAFE_INPUT_SCHEMA,
  EXCEPTION_BREAKPOINT_MODE_SCHEMA,
  LIST_BREAKPOINTS_INPUT_SCHEMA,
  LIST_TARGETS_INPUT_SCHEMA,
  OPAQUE_REFERENCE_SCHEMA,
  PAUSE_INPUT_SCHEMA,
  REMOVE_BREAKPOINT_INPUT_SCHEMA,
  SCOPES_INPUT_SCHEMA,
  SESSION_REF_SCHEMA,
  SET_EXCEPTION_BREAKPOINTS_INPUT_SCHEMA,
  SNAPSHOT_INPUT_SCHEMA,
  STACK_TRACE_INPUT_SCHEMA,
  STATUS_INPUT_SCHEMA,
  STEP_INPUT_SCHEMA,
  THREADS_INPUT_SCHEMA,
  VARIABLES_INPUT_SCHEMA,
  WAIT_FOR_EVENT_INPUT_SCHEMA,
} from "../../mcp-extension/src/tools/schemas.js";
import {
  STRUCTURED_TOOL_ERROR_SCHEMA,
  TOOL_ERROR_CODE_SCHEMA,
  dapFailureError,
  type StructuredToolError,
} from "../../mcp-extension/src/tools/errors.js";
import { BridgeCallError } from "./bridgeClient.js";

const MAX_DISPLAY_LENGTH = 4_096;
const MAX_EVENT_OUTPUT_LENGTH = 65_536;
const MAX_SUMMARY_LENGTH = 256;

const SAFE_INTEGER_SCHEMA = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const POSITIVE_INTEGER_SCHEMA = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const DISPLAY_SCHEMA = z.string().max(MAX_DISPLAY_LENGTH);
const NON_EMPTY_DISPLAY_SCHEMA = DISPLAY_SCHEMA.min(1);
const NON_EMPTY_STRING_SCHEMA = z.string().min(1);
const ERROR_WIRE_SCHEMA = z.strictObject({
  code: TOOL_ERROR_CODE_SCHEMA,
  message: z.string(),
  retryable: z.boolean(),
  currentState: z.string(),
  action: z.string(),
});
const DEBUG_STATE_SCHEMA = z.enum([
  "starting",
  "running",
  "stopped",
  "reloading",
  "terminated",
]);

const SESSION_SELECTION_SCHEMA = z.strictObject({
  sessionRef: SESSION_REF_SCHEMA,
  tracked: z.boolean(),
});
const TRACKED_SESSION_SELECTION_SCHEMA = z.strictObject({
  sessionRef: SESSION_REF_SCHEMA,
  tracked: z.literal(true),
});
const EVENT_OUTPUT_SCHEMA = z.string().superRefine((value, context) => {
  if (Buffer.byteLength(value, "utf8") > MAX_EVENT_OUTPUT_LENGTH) {
    context.addIssue({ code: "custom", message: "Event output exceeds its byte limit." });
  }
});

const TARGET_SCHEMA = z.strictObject({
  targetId: NON_EMPTY_STRING_SCHEMA,
  processId: POSITIVE_INTEGER_SCHEMA,
  projectName: NON_EMPTY_STRING_SCHEMA,
  workspaceRoot: NON_EMPTY_STRING_SCHEMA,
  projectVersion: NON_EMPTY_STRING_SCHEMA,
  source: z.enum(["advertisement", "derived-port"]),
});

const ATTACHED_METADATA_SHAPE = {
  sessionRef: SESSION_REF_SCHEMA,
  state: DEBUG_STATE_SCHEMA,
  stopGeneration: SAFE_INTEGER_SCHEMA,
  eventSequence: SAFE_INTEGER_SCHEMA,
} as const;
const STOPPED_METADATA_SHAPE = {
  sessionRef: SESSION_REF_SCHEMA,
  state: z.literal("stopped"),
  stopGeneration: SAFE_INTEGER_SCHEMA,
  eventSequence: SAFE_INTEGER_SCHEMA,
} as const;

const ATTACHED_STATUS_SCHEMA = z.strictObject({
  session: SESSION_SELECTION_SCHEMA,
  state: DEBUG_STATE_SCHEMA,
  stopGeneration: SAFE_INTEGER_SCHEMA,
  eventSequence: SAFE_INTEGER_SCHEMA,
});

const NOT_ATTACHED_STATUS_SCHEMA = z.strictObject({
  session: z.null(),
  state: z.literal("not-attached"),
  eventSequence: z.literal(0),
});

const STATUS_OUTPUT_SCHEMA = z.strictObject({
  session: SESSION_SELECTION_SCHEMA.nullable(),
  state: z.union([DEBUG_STATE_SCHEMA, z.literal("not-attached")]),
  stopGeneration: SAFE_INTEGER_SCHEMA.optional(),
  eventSequence: SAFE_INTEGER_SCHEMA,
}).superRefine((value, context) => {
  const valid = value.session === null
    ? NOT_ATTACHED_STATUS_SCHEMA.safeParse(value).success
    : ATTACHED_STATUS_SCHEMA.safeParse(value).success;
  if (!valid) {
    context.addIssue({ code: "custom", message: "Invalid debugger status." });
  }
});

const SOURCE_BREAKPOINT_SCHEMA = z.strictObject({
  kind: z.literal("source"),
  sourcePath: NON_EMPTY_STRING_SCHEMA,
  line: POSITIVE_INTEGER_SCHEMA,
  enabled: z.boolean(),
  conditional: z.boolean(),
  ownedByMcp: z.boolean(),
  removable: z.boolean(),
  breakpointRef: BREAKPOINT_REF_SCHEMA.optional(),
}).superRefine((value, context) => {
  if (
    value.ownedByMcp !== value.removable ||
    value.ownedByMcp !== (value.breakpointRef !== undefined)
  ) {
    context.addIssue({ code: "custom", message: "Invalid breakpoint ownership." });
  }
});

const OTHER_BREAKPOINT_SCHEMA = z.strictObject({
  kind: z.literal("other"),
  enabled: z.boolean(),
  ownedByMcp: z.literal(false),
  removable: z.literal(false),
});

const THREAD_SCHEMA = z.strictObject({
  threadRef: OPAQUE_REFERENCE_SCHEMA,
  name: NON_EMPTY_DISPLAY_SCHEMA,
  truncated: z.literal(true).optional(),
});

const FRAME_SCHEMA = z.strictObject({
  frameRef: OPAQUE_REFERENCE_SCHEMA,
  name: NON_EMPTY_DISPLAY_SCHEMA,
  line: SAFE_INTEGER_SCHEMA,
  column: SAFE_INTEGER_SCHEMA,
  sourceName: NON_EMPTY_DISPLAY_SCHEMA.optional(),
  truncated: z.literal(true).optional(),
});

const SCOPE_SCHEMA = z.strictObject({
  name: NON_EMPTY_DISPLAY_SCHEMA,
  expensive: z.boolean(),
  variablesRef: OPAQUE_REFERENCE_SCHEMA,
  truncated: z.literal(true).optional(),
});

const VARIABLE_SCHEMA = z.strictObject({
  name: NON_EMPTY_DISPLAY_SCHEMA,
  value: DISPLAY_SCHEMA,
  type: DISPLAY_SCHEMA.optional(),
  variablesRef: OPAQUE_REFERENCE_SCHEMA.optional(),
  truncated: z.literal(true).optional(),
});

const EVENT_SCHEMA = z.discriminatedUnion("kind", [
  z.strictObject({
    sequence: POSITIVE_INTEGER_SCHEMA,
    kind: z.literal("stopped"),
    phase: z.literal("stopped"),
    stopGeneration: SAFE_INTEGER_SCHEMA,
    reason: NON_EMPTY_STRING_SCHEMA,
  }),
  z.strictObject({
    sequence: POSITIVE_INTEGER_SCHEMA,
    kind: z.literal("continued"),
    phase: z.literal("running"),
    stopGeneration: SAFE_INTEGER_SCHEMA,
  }),
  z.strictObject({
    sequence: POSITIVE_INTEGER_SCHEMA,
    kind: z.literal("reload-started"),
    phase: z.literal("reloading"),
    stopGeneration: SAFE_INTEGER_SCHEMA,
  }),
  z.strictObject({
    sequence: POSITIVE_INTEGER_SCHEMA,
    kind: z.literal("reload-completed"),
    phase: z.literal("running"),
    stopGeneration: SAFE_INTEGER_SCHEMA,
  }),
  z.strictObject({
    sequence: POSITIVE_INTEGER_SCHEMA,
    kind: z.literal("terminated"),
    phase: z.literal("terminated"),
    stopGeneration: SAFE_INTEGER_SCHEMA,
  }),
  z.strictObject({
    sequence: POSITIVE_INTEGER_SCHEMA,
    kind: z.literal("breakpoint"),
  }),
  z.strictObject({
    sequence: POSITIVE_INTEGER_SCHEMA,
    kind: z.literal("reload-progress"),
    output: EVENT_OUTPUT_SCHEMA,
  }),
  z.strictObject({
    sequence: POSITIVE_INTEGER_SCHEMA,
    kind: z.literal("output"),
    output: EVENT_OUTPUT_SCHEMA,
  }),
]);

const RESULT_SCHEMAS = Object.freeze({
  unity_debug_list_targets: z.strictObject({
    targets: z.array(TARGET_SCHEMA),
  }),
  unity_debug_attach: ATTACHED_STATUS_SCHEMA.extend({
    session: TRACKED_SESSION_SELECTION_SCHEMA,
    reused: z.boolean(),
  }),
  unity_debug_status: STATUS_OUTPUT_SCHEMA,
  unity_debug_disconnect: z.strictObject({
    sessionRef: SESSION_REF_SCHEMA,
    terminated: z.boolean(),
  }),
  unity_debug_list_breakpoints: z.strictObject({
    breakpoints: z.array(z.union([SOURCE_BREAKPOINT_SCHEMA, OTHER_BREAKPOINT_SCHEMA])),
  }),
  unity_debug_add_breakpoint: z.strictObject({
    breakpoint: z.strictObject({ breakpointRef: BREAKPOINT_REF_SCHEMA }),
  }),
  unity_debug_remove_breakpoint: z.strictObject({
    breakpointRef: BREAKPOINT_REF_SCHEMA,
    removed: z.literal(true),
  }),
  unity_debug_set_exception_breakpoints: z.strictObject({
    sessionRef: SESSION_REF_SCHEMA,
    mode: EXCEPTION_BREAKPOINT_MODE_SCHEMA,
  }),
  unity_debug_threads: z.strictObject({
    ...STOPPED_METADATA_SHAPE,
    threads: z.array(THREAD_SCHEMA),
  }),
  unity_debug_stack_trace: z.strictObject({
    ...STOPPED_METADATA_SHAPE,
    totalFrames: SAFE_INTEGER_SCHEMA,
    frames: z.array(FRAME_SCHEMA).max(20),
  }),
  unity_debug_scopes: z.strictObject({
    ...STOPPED_METADATA_SHAPE,
    scopes: z.array(SCOPE_SCHEMA),
  }),
  unity_debug_variables: z.strictObject({
    ...STOPPED_METADATA_SHAPE,
    variables: z.array(VARIABLE_SCHEMA).max(100),
  }),
  unity_debug_snapshot: z.strictObject({
    ...STOPPED_METADATA_SHAPE,
    reason: NON_EMPTY_STRING_SCHEMA,
    thread: THREAD_SCHEMA.nullable(),
    frames: z.array(FRAME_SCHEMA).max(20),
    scopes: z.array(SCOPE_SCHEMA),
    variables: z.array(VARIABLE_SCHEMA).max(100),
  }),
  unity_debug_evaluate_safe: z.strictObject({
    ...STOPPED_METADATA_SHAPE,
    result: DISPLAY_SCHEMA,
    type: DISPLAY_SCHEMA.optional(),
    variablesRef: OPAQUE_REFERENCE_SCHEMA.optional(),
    truncated: z.literal(true).optional(),
  }),
  unity_debug_evaluate_explicit: z.strictObject({
    ...STOPPED_METADATA_SHAPE,
    result: DISPLAY_SCHEMA,
    type: DISPLAY_SCHEMA.optional(),
    variablesRef: OPAQUE_REFERENCE_SCHEMA.optional(),
    truncated: z.literal(true).optional(),
  }),
  unity_debug_pause: z.strictObject({
    ...ATTACHED_METADATA_SHAPE,
    transitioning: z.boolean(),
  }),
  unity_debug_continue: z.strictObject({
    ...ATTACHED_METADATA_SHAPE,
    transitioning: z.boolean(),
  }),
  unity_debug_step: z.strictObject({
    ...ATTACHED_METADATA_SHAPE,
    transitioning: z.boolean(),
    kind: z.enum(["in", "over", "out"]),
  }),
  unity_debug_wait_for_event: z.strictObject({
    ...ATTACHED_METADATA_SHAPE,
    event: EVENT_SCHEMA,
  }),
} satisfies Record<ToolName, z.ZodType>);

const INPUT_SCHEMAS = Object.freeze({
  unity_debug_list_targets: LIST_TARGETS_INPUT_SCHEMA,
  unity_debug_attach: ATTACH_INPUT_SCHEMA,
  unity_debug_status: STATUS_INPUT_SCHEMA,
  unity_debug_disconnect: DISCONNECT_INPUT_SCHEMA,
  unity_debug_list_breakpoints: LIST_BREAKPOINTS_INPUT_SCHEMA,
  unity_debug_add_breakpoint: ADD_BREAKPOINT_INPUT_SCHEMA,
  unity_debug_remove_breakpoint: REMOVE_BREAKPOINT_INPUT_SCHEMA,
  unity_debug_set_exception_breakpoints: SET_EXCEPTION_BREAKPOINTS_INPUT_SCHEMA,
  unity_debug_threads: THREADS_INPUT_SCHEMA,
  unity_debug_stack_trace: STACK_TRACE_INPUT_SCHEMA,
  unity_debug_scopes: SCOPES_INPUT_SCHEMA,
  unity_debug_variables: VARIABLES_INPUT_SCHEMA,
  unity_debug_snapshot: SNAPSHOT_INPUT_SCHEMA,
  unity_debug_evaluate_safe: EVALUATE_SAFE_INPUT_SCHEMA,
  unity_debug_evaluate_explicit: EVALUATE_EXPLICIT_INPUT_SCHEMA,
  unity_debug_pause: PAUSE_INPUT_SCHEMA,
  unity_debug_continue: CONTINUE_INPUT_SCHEMA,
  unity_debug_step: STEP_INPUT_SCHEMA,
  unity_debug_wait_for_event: WAIT_FOR_EVENT_INPUT_SCHEMA,
} satisfies Record<ToolName, z.ZodType>);

const DESCRIPTIONS = Object.freeze({
  unity_debug_list_targets: "List debugger targets in the current trusted workspace.",
  unity_debug_attach: "Attach to a target returned by the latest target listing.",
  unity_debug_status: "Read the normalized state of a selected debugger session.",
  unity_debug_disconnect: "Release a selection or explicitly terminate its debug session.",
  unity_debug_list_breakpoints: "List workspace breakpoints and MCP ownership metadata.",
  unity_debug_add_breakpoint: "Add an MCP-owned source breakpoint.",
  unity_debug_remove_breakpoint: "Remove one MCP-owned source breakpoint.",
  unity_debug_set_exception_breakpoints: "Set the debugger exception break mode.",
  unity_debug_threads: "List stopped debugger threads using opaque references.",
  unity_debug_stack_trace: "Read a bounded stack trace using an opaque thread reference.",
  unity_debug_scopes: "List scopes for an opaque stack frame reference.",
  unity_debug_variables: "Read bounded variables using an opaque variables reference.",
  unity_debug_snapshot: "Read a bounded stopped-state snapshot.",
  unity_debug_evaluate_safe: "Evaluate without permitting target code execution.",
  unity_debug_evaluate_explicit: "Evaluate with literal consent for target side effects.",
  unity_debug_pause: "Pause a running debugger session.",
  unity_debug_continue: "Continue a stopped debugger session.",
  unity_debug_step: "Step into, over, or out from the current stopped location.",
  unity_debug_wait_for_event: "Wait for the next matching normalized debugger event.",
} satisfies Record<ToolName, string>);

const READ_ONLY = new Set<ToolName>([
  "unity_debug_list_targets",
  "unity_debug_status",
  "unity_debug_list_breakpoints",
  "unity_debug_threads",
  "unity_debug_stack_trace",
  "unity_debug_scopes",
  "unity_debug_variables",
  "unity_debug_snapshot",
  "unity_debug_evaluate_safe",
  "unity_debug_wait_for_event",
]);

const DESTRUCTIVE = new Set<ToolName>([
  "unity_debug_disconnect",
  "unity_debug_remove_breakpoint",
  "unity_debug_evaluate_explicit",
  "unity_debug_continue",
  "unity_debug_step",
]);

const IDEMPOTENT_MUTATIONS = new Set<ToolName>([
  "unity_debug_set_exception_breakpoints",
]);

export interface BridgeToolCaller {
  callTool(name: ToolName, input: unknown, signal?: AbortSignal): Promise<unknown>;
}

interface ToolDefinition {
  readonly name: ToolName;
  readonly description: string;
  readonly inputSchema: z.ZodType;
  readonly successSchema: z.ZodType;
  readonly outputSchema: z.ZodType;
  readonly annotations: ToolAnnotations & {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly idempotentHint: boolean;
    readonly openWorldHint: false;
  };
}

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = Object.freeze(
  TOOL_NAMES.map((name): ToolDefinition => {
    const successSchema = RESULT_SCHEMAS[name];
    return Object.freeze({
      name,
      description: DESCRIPTIONS[name],
      inputSchema: INPUT_SCHEMAS[name],
      successSchema,
      outputSchema: errorAwareObjectSchema(successSchema),
      annotations: Object.freeze({
        readOnlyHint: READ_ONLY.has(name),
        destructiveHint: DESTRUCTIVE.has(name),
        idempotentHint: READ_ONLY.has(name) || IDEMPOTENT_MUTATIONS.has(name),
        openWorldHint: false as const,
      }),
    });
  }),
);

export function createUnityDebuggerMcpServer(bridge: BridgeToolCaller): McpServer {
  const server = new SanitizingMcpServer({
    name: "unity-debugger-pure-mcp",
    version: "0.1.0",
  });

  for (const definition of TOOL_DEFINITIONS) {
    server.registerTool(definition.name, {
      description: definition.description,
      inputSchema: definition.inputSchema,
      outputSchema: definition.outputSchema,
      annotations: definition.annotations,
    }, async (input: unknown, extra) => {
      try {
        const parsedInput = definition.inputSchema.parse(input);
        const bridgeResult = await bridge.callTool(
          definition.name,
          parsedInput,
          extra.signal,
        );
        const structuredContent = definition.successSchema.parse(bridgeResult) as Record<string, unknown>;
        return {
          structuredContent,
          content: [{
            type: "text" as const,
            text: successSummary(definition.name, structuredContent),
          }],
        };
      } catch (error) {
        return errorResult(error);
      }
    });
  }

  return server;
}

/**
 * MCP SDK 1.30 only publishes top-level object schemas, so a Zod union of each
 * strict success object and StructuredToolError is omitted from tools/list.
 * Its client also validates error structuredContent against the published
 * schema. Keep the exact success schema separately for bridge validation and
 * publish this strict-key object union so listed clients can consume both.
 */
function errorAwareObjectSchema(successSchema: z.ZodType): z.ZodType {
  const objectSchema = successSchema as z.ZodObject<z.ZodRawShape>;
  const optionalSuccessShape = Object.fromEntries(
    Object.entries(objectSchema.shape).map(([key, schema]) => [
      key,
      (schema as z.ZodType).optional(),
    ]),
  ) as z.ZodRawShape;
  return z.strictObject({
    ...optionalSuccessShape,
    code: ERROR_WIRE_SCHEMA.shape.code.optional(),
    message: ERROR_WIRE_SCHEMA.shape.message.optional(),
    retryable: ERROR_WIRE_SCHEMA.shape.retryable.optional(),
    currentState: ERROR_WIRE_SCHEMA.shape.currentState.optional(),
    action: ERROR_WIRE_SCHEMA.shape.action.optional(),
  }).superRefine((value, context) => {
    if (
      !successSchema.safeParse(value).success &&
      !STRUCTURED_TOOL_ERROR_SCHEMA.safeParse(value).success
    ) {
      context.addIssue({ code: "custom", message: "Invalid tool result." });
    }
  });
}

/** Converts SDK-generated validation errors before they can expose Zod data. */
class SanitizingMcpServer extends McpServer {
  public override connect(transport: Transport): Promise<void> {
    return super.connect(new SanitizingTransport(transport));
  }
}

class SanitizingTransport implements Transport {
  public onclose: (() => void) | undefined;
  public onerror: ((error: Error) => void) | undefined;
  public onmessage: Transport["onmessage"];

  public constructor(private readonly transport: Transport) {}

  public get sessionId(): string | undefined {
    return this.transport.sessionId;
  }

  public setProtocolVersion(version: string): void {
    this.transport.setProtocolVersion?.(version);
  }

  public async start(): Promise<void> {
    this.transport.onclose = () => this.onclose?.();
    this.transport.onerror = (error) => this.onerror?.(error);
    this.transport.onmessage = (message, extra) => this.onmessage?.(message, extra);
    await this.transport.start();
  }

  public send(message: JSONRPCMessage, options?: Parameters<Transport["send"]>[1]): Promise<void> {
    return this.transport.send(sanitizeSdkError(message), options);
  }

  public close(): Promise<void> {
    return this.transport.close();
  }
}

function sanitizeSdkError(message: JSONRPCMessage): JSONRPCMessage {
  if (
    typeof message === "object" &&
    message !== null &&
    "result" in message &&
    typeof message.result === "object" &&
    message.result !== null &&
    !Array.isArray(message.result) &&
    message.result.isError === true &&
    !("structuredContent" in message.result)
  ) {
    return {
      ...message,
      result: errorResult(undefined),
    } as JSONRPCMessage;
  }
  return message;
}

function errorResult(error: unknown): CallToolResult {
  let detail: StructuredToolError | undefined;
  try {
    if (error instanceof BridgeCallError) {
      const parsed = STRUCTURED_TOOL_ERROR_SCHEMA.safeParse(error.detail);
      if (parsed.success) {
        detail = Object.freeze(parsed.data);
      }
    }
  } catch {
    detail = undefined;
  }
  const safeDetail = detail ?? Object.freeze(dapFailureError());
  return {
    isError: true as const,
    structuredContent: safeDetail as unknown as Record<string, unknown>,
    content: [{
      type: "text" as const,
      text: boundedText(`${safeDetail.code}: ${safeDetail.message}`),
    }],
  };
}

function successSummary(name: ToolName, result: Record<string, unknown>): string {
  let summary: string;
  switch (name) {
    case "unity_debug_list_targets":
      summary = `Found ${arrayLength(result.targets)} debugger targets.`;
      break;
    case "unity_debug_attach":
      summary = result.reused === true
        ? "Selected an existing Unity debugger session."
        : "Started and selected a Unity debugger session.";
      break;
    case "unity_debug_status":
      summary = result.session === null
        ? "No Unity debugger session is selected."
        : `Unity debugger state: ${String(result.state)}.`;
      break;
    case "unity_debug_disconnect":
      summary = result.terminated === true
        ? "Terminated the selected Unity debugger session."
        : "Released the MCP debugger selection.";
      break;
    case "unity_debug_list_breakpoints":
      summary = `Returned ${arrayLength(result.breakpoints)} workspace breakpoints.`;
      break;
    case "unity_debug_add_breakpoint":
      summary = "Added an MCP-owned source breakpoint.";
      break;
    case "unity_debug_remove_breakpoint":
      summary = "Removed the MCP-owned source breakpoint.";
      break;
    case "unity_debug_set_exception_breakpoints":
      summary = `Exception break mode: ${String(result.mode)}.`;
      break;
    case "unity_debug_threads":
      summary = `Returned ${arrayLength(result.threads)} debugger threads.`;
      break;
    case "unity_debug_stack_trace":
      summary = `Returned ${arrayLength(result.frames)} stack frames.`;
      break;
    case "unity_debug_scopes":
      summary = `Returned ${arrayLength(result.scopes)} debugger scopes.`;
      break;
    case "unity_debug_variables":
      summary = `Returned ${arrayLength(result.variables)} debugger variables.`;
      break;
    case "unity_debug_snapshot":
      summary = `Captured ${arrayLength(result.frames)} frames and ${arrayLength(result.variables)} variables.`;
      break;
    case "unity_debug_evaluate_safe":
      summary = "Completed safe debugger evaluation.";
      break;
    case "unity_debug_evaluate_explicit":
      summary = "Completed explicitly authorized debugger evaluation.";
      break;
    case "unity_debug_pause":
      summary = "Requested debugger pause.";
      break;
    case "unity_debug_continue":
      summary = "Requested debugger continue.";
      break;
    case "unity_debug_step":
      summary = `Requested debugger step ${String(result.kind)}.`;
      break;
    case "unity_debug_wait_for_event":
      summary = "Received a matching debugger event.";
      break;
  }
  return boundedText(summary);
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function boundedText(value: string): string {
  if (value.length <= MAX_SUMMARY_LENGTH) {
    return value;
  }
  let end = MAX_SUMMARY_LENGTH - 1;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    end -= 1;
  }
  return `${value.slice(0, end)}…`;
}
