import { describe, expect, it, vi } from "vitest";

import { FrameDecoder, encodeFrame } from "../../mcp-extension/src/bridge/framing.js";
import {
  CLIENT_FRAME_SCHEMA,
  SERVER_FRAME_SCHEMA,
  TOOL_ERROR_CODES,
  TOOL_NAMES,
} from "../../mcp-extension/src/bridge/protocol.js";

describe("bridge framing", () => {
  it("decodes split and coalesced length-prefixed frames", () => {
    const decoder = new FrameDecoder(1_048_576);
    const first = encodeFrame({ type: "hello", protocolVersion: 1, token: "x" });
    const second = encodeFrame({
      type: "request",
      id: "1",
      method: "callTool",
      params: { name: "unity_debug_status", input: {} },
    });

    expect(decoder.push(first.subarray(0, 3))).toEqual([]);
    expect(decoder.push(Buffer.concat([first.subarray(3), second]))).toEqual([
      { type: "hello", protocolVersion: 1, token: "x" },
      {
        type: "request",
        id: "1",
        method: "callTool",
        params: { name: "unity_debug_status", input: {} },
      },
    ]);
  });

  it("rejects a declared frame larger than 1 MiB", () => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32LE(1_048_577);

    expect(() => new FrameDecoder(1_048_576).push(bytes)).toThrow(
      "Bridge frame exceeds 1048576 bytes.",
    );
  });

  it("rejects an encoded payload larger than 1 MiB", () => {
    expect(() => encodeFrame({ value: "x".repeat(1_048_576) })).toThrow(
      "Bridge frame exceeds 1048576 bytes.",
    );
  });

  it("copies many tiny fragments within a linear-growth budget", () => {
    const frame = encodeFrame({ value: "x".repeat(16_384) });
    const originalConcat = Buffer.concat;
    let concatenatedBytes = 0;
    const concat = vi.spyOn(Buffer, "concat").mockImplementation((buffers, totalLength) => {
      const bytes = totalLength ?? buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
      concatenatedBytes += bytes;
      return originalConcat(buffers, totalLength);
    });

    try {
      const decoder = new FrameDecoder();
      const decoded: unknown[] = [];
      for (let index = 0; index < frame.byteLength; index += 1) {
        decoded.push(...decoder.push(frame.subarray(index, index + 1)));
      }

      expect(decoded).toEqual([{ value: "x".repeat(16_384) }]);
      expect(concatenatedBytes).toBeLessThan(frame.byteLength * 20);
    } finally {
      concat.mockRestore();
    }
  });

  it("accepts exactly the 19 supported tool names", () => {
    const expected = [
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
    ];

    expect(TOOL_NAMES).toEqual(expected);
    for (const name of expected) {
      expect(
        CLIENT_FRAME_SCHEMA.safeParse({
          type: "request",
          id: "request-1",
          method: "callTool",
          params: { name, input: null },
        }).success,
      ).toBe(true);
    }
    expect(
      CLIENT_FRAME_SCHEMA.safeParse({
        type: "request",
        id: "request-1",
        method: "callTool",
        params: { name: "unity_debug_unknown", input: null },
      }).success,
    ).toBe(false);
  });

  it("accepts every structured error code and rejects unknown fields", () => {
    const expected = [
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
    ];

    expect(TOOL_ERROR_CODES).toEqual(expected);
    for (const code of expected) {
      expect(
        SERVER_FRAME_SCHEMA.safeParse({
          type: "response",
          id: "request-1",
          error: {
            code,
            message: "Request failed.",
            retryable: false,
            currentState: "attached",
            action: "Retry the request.",
          },
        }).success,
      ).toBe(true);
    }
    expect(
      CLIENT_FRAME_SCHEMA.safeParse({
        type: "hello",
        protocolVersion: 1,
        token: "secret",
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      SERVER_FRAME_SCHEMA.safeParse({
        type: "helloAck",
        protocolVersion: 1,
        extra: true,
      }).success,
    ).toBe(false);
  });

  it("requires request input and exactly one response payload", () => {
    expect(
      CLIENT_FRAME_SCHEMA.safeParse({
        type: "request",
        id: "request-1",
        method: "callTool",
        params: { name: "unity_debug_status" },
      }).success,
    ).toBe(false);
    expect(
      SERVER_FRAME_SCHEMA.safeParse({ type: "response", id: "request-1" }).success,
    ).toBe(false);
    expect(
      SERVER_FRAME_SCHEMA.safeParse({
        type: "response",
        id: "request-1",
        result: null,
        error: {
          code: "DAP_FAILURE",
          message: "Request failed.",
          retryable: false,
          currentState: "attached",
          action: "Check status.",
        },
      }).success,
    ).toBe(false);
  });
});
