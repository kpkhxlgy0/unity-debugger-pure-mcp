import { z } from "zod";

const MAX_REFERENCE_LENGTH = 256;
const MAX_SOURCE_PATH_LENGTH = 4_096;
const MAX_EXPRESSION_LENGTH = 4_096;

export const OPAQUE_REFERENCE_SCHEMA = z.string().min(1).max(MAX_REFERENCE_LENGTH);
export const TARGET_ID_SCHEMA = OPAQUE_REFERENCE_SCHEMA;
export const SESSION_REF_SCHEMA = OPAQUE_REFERENCE_SCHEMA;
export const BREAKPOINT_REF_SCHEMA = OPAQUE_REFERENCE_SCHEMA;
export const SOURCE_PATH_SCHEMA = z.string().min(1).max(MAX_SOURCE_PATH_LENGTH);
export const BREAKPOINT_CONDITION_SCHEMA = z.string().min(1).max(1_024);
export const SOURCE_LINE_SCHEMA = z.number().int().positive().max(2_147_483_647);
export const EXCEPTION_BREAKPOINT_MODE_SCHEMA = z.enum(["none", "uncaught", "all"]);

export const LIST_TARGETS_INPUT_SCHEMA = z.object({}).strict();

export const ATTACH_INPUT_SCHEMA = z.object({
  targetId: TARGET_ID_SCHEMA,
}).strict();

export const STATUS_INPUT_SCHEMA = z.object({
  sessionRef: SESSION_REF_SCHEMA.optional(),
}).strict();

export const DISCONNECT_INPUT_SCHEMA = z.object({
  sessionRef: SESSION_REF_SCHEMA.optional(),
  terminateSession: z.boolean().optional().default(false),
}).strict();

export const LIST_BREAKPOINTS_INPUT_SCHEMA = z.object({}).strict();

export const ADD_BREAKPOINT_INPUT_SCHEMA = z.object({
  sourcePath: SOURCE_PATH_SCHEMA,
  line: SOURCE_LINE_SCHEMA,
  condition: BREAKPOINT_CONDITION_SCHEMA.optional(),
}).strict();

export const REMOVE_BREAKPOINT_INPUT_SCHEMA = z.object({
  breakpointRef: BREAKPOINT_REF_SCHEMA,
}).strict();

export const SET_EXCEPTION_BREAKPOINTS_INPUT_SCHEMA = z.object({
  sessionRef: SESSION_REF_SCHEMA.optional(),
  mode: EXCEPTION_BREAKPOINT_MODE_SCHEMA,
}).strict();

const OPTIONAL_SESSION_SCHEMA = {
  sessionRef: SESSION_REF_SCHEMA.optional(),
} as const;

export const THREADS_INPUT_SCHEMA = z.object(OPTIONAL_SESSION_SCHEMA).strict();

export const STACK_TRACE_INPUT_SCHEMA = z.object({
  ...OPTIONAL_SESSION_SCHEMA,
  threadRef: OPAQUE_REFERENCE_SCHEMA,
  startFrame: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().default(0),
  levels: z.number().int().positive().max(20).optional().default(20),
}).strict();

export const SCOPES_INPUT_SCHEMA = z.object({
  ...OPTIONAL_SESSION_SCHEMA,
  frameRef: OPAQUE_REFERENCE_SCHEMA,
}).strict();

export const VARIABLES_INPUT_SCHEMA = z.object({
  ...OPTIONAL_SESSION_SCHEMA,
  variablesRef: OPAQUE_REFERENCE_SCHEMA,
  start: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().default(0),
  count: z.number().int().positive().max(100).optional().default(100),
}).strict();

export const SNAPSHOT_INPUT_SCHEMA = z.object(OPTIONAL_SESSION_SCHEMA).strict();

export const EVALUATE_SAFE_INPUT_SCHEMA = z.object({
  ...OPTIONAL_SESSION_SCHEMA,
  frameRef: OPAQUE_REFERENCE_SCHEMA,
  expression: z.string().min(1).max(MAX_EXPRESSION_LENGTH),
}).strict();

export const EVALUATE_EXPLICIT_INPUT_SCHEMA = z.object({
  ...OPTIONAL_SESSION_SCHEMA,
  frameRef: OPAQUE_REFERENCE_SCHEMA,
  expression: z.string().min(1).max(MAX_EXPRESSION_LENGTH),
  allowSideEffects: z.literal(true),
}).strict();

export const PAUSE_INPUT_SCHEMA = z.object(OPTIONAL_SESSION_SCHEMA).strict();
export const CONTINUE_INPUT_SCHEMA = z.object(OPTIONAL_SESSION_SCHEMA).strict();

export const STEP_INPUT_SCHEMA = z.object({
  ...OPTIONAL_SESSION_SCHEMA,
  kind: z.enum(["in", "over", "out"]),
}).strict();

export const WAIT_FOR_EVENT_INPUT_SCHEMA = z.object({
  ...OPTIONAL_SESSION_SCHEMA,
  afterSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  kinds: z.array(z.enum([
    "stopped",
    "continued",
    "breakpoint",
    "reload-started",
    "reload-progress",
    "reload-completed",
    "output",
    "terminated",
  ])).max(8).optional(),
  timeoutMs: z.number().int().nonnegative().max(60_000).optional(),
}).strict();

export const LIFECYCLE_AND_BREAKPOINT_INPUT_SCHEMAS = Object.freeze({
  unity_debug_list_targets: LIST_TARGETS_INPUT_SCHEMA,
  unity_debug_attach: ATTACH_INPUT_SCHEMA,
  unity_debug_status: STATUS_INPUT_SCHEMA,
  unity_debug_disconnect: DISCONNECT_INPUT_SCHEMA,
  unity_debug_list_breakpoints: LIST_BREAKPOINTS_INPUT_SCHEMA,
  unity_debug_add_breakpoint: ADD_BREAKPOINT_INPUT_SCHEMA,
  unity_debug_remove_breakpoint: REMOVE_BREAKPOINT_INPUT_SCHEMA,
  unity_debug_set_exception_breakpoints: SET_EXCEPTION_BREAKPOINTS_INPUT_SCHEMA,
});

export type AddBreakpointInput = z.infer<typeof ADD_BREAKPOINT_INPUT_SCHEMA>;
export type ExceptionBreakpointMode = z.infer<typeof EXCEPTION_BREAKPOINT_MODE_SCHEMA>;
export type StackTraceInput = z.infer<typeof STACK_TRACE_INPUT_SCHEMA>;
export type ScopesInput = z.infer<typeof SCOPES_INPUT_SCHEMA>;
export type VariablesInput = z.infer<typeof VARIABLES_INPUT_SCHEMA>;
export type EvaluateSafeInput = z.infer<typeof EVALUATE_SAFE_INPUT_SCHEMA>;
export type EvaluateExplicitInput = z.infer<typeof EVALUATE_EXPLICIT_INPUT_SCHEMA>;
export type StepInput = z.infer<typeof STEP_INPUT_SCHEMA>;
export type WaitForEventInput = z.infer<typeof WAIT_FOR_EVENT_INPUT_SCHEMA>;
