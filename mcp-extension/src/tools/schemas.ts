import { z } from "zod";

const MAX_REFERENCE_LENGTH = 256;
const MAX_SOURCE_PATH_LENGTH = 4_096;

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
