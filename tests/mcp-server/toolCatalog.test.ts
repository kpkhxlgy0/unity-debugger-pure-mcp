import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TOOL_NAMES, type ToolName } from "../../mcp-extension/src/bridge/protocol.js";
import { BridgeCallError } from "../../mcp-server/src/bridgeClient.js";
import {
  createUnityDebuggerMcpServer,
  TOOL_DEFINITIONS,
  type BridgeToolCaller,
} from "../../mcp-server/src/toolCatalog.js";

const OPEN_WORLD_CLOSED = { openWorldHint: false } as const;

const EXPECTED_ANNOTATIONS = Object.freeze({
  unity_debug_list_targets: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, ...OPEN_WORLD_CLOSED },
  unity_debug_attach: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, ...OPEN_WORLD_CLOSED },
  unity_debug_status: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, ...OPEN_WORLD_CLOSED },
  unity_debug_disconnect: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, ...OPEN_WORLD_CLOSED },
  unity_debug_list_breakpoints: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, ...OPEN_WORLD_CLOSED },
  unity_debug_add_breakpoint: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, ...OPEN_WORLD_CLOSED },
  unity_debug_remove_breakpoint: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, ...OPEN_WORLD_CLOSED },
  unity_debug_set_exception_breakpoints: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, ...OPEN_WORLD_CLOSED },
  unity_debug_threads: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, ...OPEN_WORLD_CLOSED },
  unity_debug_stack_trace: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, ...OPEN_WORLD_CLOSED },
  unity_debug_scopes: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, ...OPEN_WORLD_CLOSED },
  unity_debug_variables: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, ...OPEN_WORLD_CLOSED },
  unity_debug_snapshot: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, ...OPEN_WORLD_CLOSED },
  unity_debug_evaluate_safe: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, ...OPEN_WORLD_CLOSED },
  unity_debug_evaluate_explicit: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, ...OPEN_WORLD_CLOSED },
  unity_debug_pause: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, ...OPEN_WORLD_CLOSED },
  unity_debug_continue: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, ...OPEN_WORLD_CLOSED },
  unity_debug_step: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, ...OPEN_WORLD_CLOSED },
  unity_debug_wait_for_event: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, ...OPEN_WORLD_CLOSED },
} satisfies Record<ToolName, {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: false;
}>);

const METADATA = Object.freeze({
  sessionRef: "opaque-session",
  state: "stopped",
  stopGeneration: 2,
  eventSequence: 4,
});

const SUCCESS_CASES = Object.freeze({
  unity_debug_list_targets: {
    input: {},
    result: { targets: [{
      targetId: "target-capability",
      processId: 123,
      projectName: "MyGame",
      workspaceRoot: "H:\\workspace\\Unity\\Tuanjie\\Projects\\MyGame",
      projectVersion: "2022.3",
      source: "advertisement",
    }] },
  },
  unity_debug_attach: {
    input: { targetId: "target-capability" },
    result: {
      session: { sessionRef: "opaque-session", tracked: true },
      state: "running",
      stopGeneration: 0,
      eventSequence: 1,
      reused: false,
    },
  },
  unity_debug_status: {
    input: {},
    result: { session: null, state: "not-attached", eventSequence: 0 },
  },
  unity_debug_disconnect: {
    input: {},
    result: { sessionRef: "opaque-session", terminated: false },
  },
  unity_debug_list_breakpoints: {
    input: {},
    result: { breakpoints: [{
      kind: "source",
      sourcePath: "H:\\workspace\\Unity\\Tuanjie\\Projects\\MyGame\\Player.cs",
      line: 12,
      enabled: true,
      conditional: false,
      ownedByMcp: false,
      removable: false,
    }] },
  },
  unity_debug_add_breakpoint: {
    input: { sourcePath: "H:\\workspace\\Unity\\Tuanjie\\Projects\\MyGame\\Player.cs", line: 12 },
    result: { breakpoint: { breakpointRef: "opaque-breakpoint" } },
  },
  unity_debug_remove_breakpoint: {
    input: { breakpointRef: "opaque-breakpoint" },
    result: { breakpointRef: "opaque-breakpoint", removed: true },
  },
  unity_debug_set_exception_breakpoints: {
    input: { mode: "uncaught" },
    result: { sessionRef: "opaque-session", mode: "uncaught" },
  },
  unity_debug_threads: {
    input: {},
    result: { ...METADATA, threads: [{ threadRef: "opaque-thread", name: "Main Thread" }] },
  },
  unity_debug_stack_trace: {
    input: { threadRef: "opaque-thread" },
    result: {
      ...METADATA,
      totalFrames: 1,
      frames: [{ frameRef: "opaque-frame", name: "Update", line: 12, column: 3, sourceName: "Player.cs" }],
    },
  },
  unity_debug_scopes: {
    input: { frameRef: "opaque-frame" },
    result: { ...METADATA, scopes: [{ name: "Locals", expensive: false, variablesRef: "opaque-scope" }] },
  },
  unity_debug_variables: {
    input: { variablesRef: "opaque-scope" },
    result: { ...METADATA, variables: [{ name: "health", value: "100", type: "System.Int32" }] },
  },
  unity_debug_snapshot: {
    input: {},
    result: {
      ...METADATA,
      reason: "breakpoint",
      thread: { threadRef: "opaque-thread", name: "Main Thread" },
      frames: [{ frameRef: "opaque-frame", name: "Update", line: 12, column: 3 }],
      scopes: [{ name: "Locals", expensive: false, variablesRef: "opaque-scope" }],
      variables: [{ name: "health", value: "100" }],
    },
  },
  unity_debug_evaluate_safe: {
    input: { frameRef: "opaque-frame", expression: "health" },
    result: { ...METADATA, result: "100", type: "System.Int32" },
  },
  unity_debug_evaluate_explicit: {
    input: { frameRef: "opaque-frame", expression: "ApplyDamage()", allowSideEffects: true },
    result: { ...METADATA, result: "null" },
  },
  unity_debug_pause: {
    input: {},
    result: { ...METADATA, state: "running", transitioning: true },
  },
  unity_debug_continue: {
    input: {},
    result: { ...METADATA, state: "running", transitioning: true },
  },
  unity_debug_step: {
    input: { kind: "over" },
    result: { ...METADATA, state: "running", transitioning: true, kind: "over" },
  },
  unity_debug_wait_for_event: {
    input: { afterSequence: 3 },
    result: { ...METADATA, event: { sequence: 4, kind: "breakpoint" } },
  },
} satisfies Record<ToolName, {
  readonly input: Record<string, unknown>;
  readonly result: Record<string, unknown>;
}>);

interface ConnectedFixture {
  readonly client: Client;
  readonly server: ReturnType<typeof createUnityDebuggerMcpServer>;
}

const connected: ConnectedFixture[] = [];

afterEach(async () => {
  await Promise.all(connected.splice(0).map(async ({ client, server }) => {
    await client.close();
    await server.close();
  }));
});

async function connect(bridge: BridgeToolCaller): Promise<ConnectedFixture> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createUnityDebuggerMcpServer(bridge);
  const client = new Client({ name: "tool-catalog-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const fixture = { client, server };
  connected.push(fixture);
  return fixture;
}

describe("Unity debugger MCP tool catalog", () => {
  it("registers the shared 19 names once, in order, with exact conservative annotations", async () => {
    const bridge: BridgeToolCaller = { callTool: vi.fn() };
    const { client } = await connect(bridge);

    const listed = await client.listTools();
    expect(listed.tools.map(({ name }) => name)).toEqual([...TOOL_NAMES]);
    expect(new Set(listed.tools.map(({ name }) => name)).size).toBe(TOOL_NAMES.length);

    for (const tool of listed.tools) {
      expect(tool.annotations).toEqual(EXPECTED_ANNOTATIONS[tool.name as ToolName]);
      expect(tool.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
      expect(tool.outputSchema).toMatchObject({ type: "object" });
    }

    const stack = listed.tools.find(({ name }) => name === "unity_debug_stack_trace");
    expect(stack?.inputSchema.required).toContain("threadRef");
    expect(stack?.inputSchema.properties).not.toHaveProperty("threadId");
    const threads = listed.tools.find(({ name }) => name === "unity_debug_threads");
    expect(JSON.stringify(threads?.outputSchema)).not.toMatch(/threadId|sessionId|frameId|variablesReference/);

    const strictStatus = TOOL_DEFINITIONS.find(({ name }) => name === "unity_debug_status")!.successSchema;
    const strictThreads = TOOL_DEFINITIONS.find(({ name }) => name === "unity_debug_threads")!.successSchema;
    expect(strictStatus.safeParse({ session: null, state: "not-attached" }).success).toBe(false);
    expect(strictThreads.safeParse({
      sessionRef: "opaque",
      state: "stopped",
      stopGeneration: 1,
      eventSequence: 1,
      threads: [],
      threadId: 7,
    }).success).toBe(false);
  });

  it("returns validated success as structured content and a bounded summary", async () => {
    const bridge = {
      callTool: vi.fn().mockResolvedValue({
        session: null,
        state: "not-attached",
        eventSequence: 0,
      }),
    } satisfies BridgeToolCaller;
    const { client } = await connect(bridge);

    const result = await client.callTool({ name: "unity_debug_status", arguments: {} });

    expect(bridge.callTool).toHaveBeenCalledTimes(1);
    expect(bridge.callTool.mock.calls[0]?.[0]).toBe("unity_debug_status");
    expect(bridge.callTool.mock.calls[0]?.[1]).toEqual({});
    expect(bridge.callTool.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
    expect(result).toMatchObject({
      structuredContent: {
        session: null,
        state: "not-attached",
        eventSequence: 0,
      },
      content: [{ type: "text", text: "No Unity debugger session is selected." }],
    });
    expect(result.isError).not.toBe(true);
  });

  it("accepts exact production-shaped success for every tool and rejects unknown success keys", async () => {
    const bridge = {
      callTool: vi.fn(async (
        name: ToolName,
        _input: unknown,
        _signal?: AbortSignal,
      ) => SUCCESS_CASES[name].result),
    } satisfies BridgeToolCaller;
    const { client } = await connect(bridge);
    await client.listTools();

    for (const name of TOOL_NAMES) {
      const fixture = SUCCESS_CASES[name];
      const definition = TOOL_DEFINITIONS.find((candidate) => candidate.name === name)!;
      expect(definition.successSchema.safeParse(fixture.result).success, name).toBe(true);
      expect(definition.successSchema.safeParse({
        ...fixture.result,
        rawSessionId: "vscode-session-id",
      }).success, name).toBe(false);

      const result = await client.callTool({ name, arguments: fixture.input });
      expect(result.isError, name).not.toBe(true);
      expect(result.structuredContent, name).toEqual(fixture.result);
    }

    expect(bridge.callTool).toHaveBeenCalledTimes(TOOL_NAMES.length);
    expect(bridge.callTool.mock.calls.every((call) => call[2] instanceof AbortSignal)).toBe(true);

    const threadsSchema = TOOL_DEFINITIONS.find(({ name }) => name === "unity_debug_threads")!.successSchema;
    expect(threadsSchema.safeParse({
      ...SUCCESS_CASES.unity_debug_threads.result,
      state: "running",
    }).success).toBe(false);
    const stackSchema = TOOL_DEFINITIONS.find(({ name }) => name === "unity_debug_stack_trace")!.successSchema;
    expect(stackSchema.safeParse({
      ...SUCCESS_CASES.unity_debug_stack_trace.result,
      frames: [{ frameRef: "opaque-frame", name: "Update", line: 12 }],
    }).success).toBe(false);
    const variablesSchema = TOOL_DEFINITIONS.find(({ name }) => name === "unity_debug_variables")!.successSchema;
    expect(variablesSchema.safeParse({
      ...SUCCESS_CASES.unity_debug_variables.result,
      variables: [{ name: "", value: "100" }],
    }).success).toBe(false);
    const snapshotSchema = TOOL_DEFINITIONS.find(({ name }) => name === "unity_debug_snapshot")!.successSchema;
    const { reason: _reason, ...snapshotWithoutReason } = SUCCESS_CASES.unity_debug_snapshot.result;
    expect(snapshotSchema.safeParse(snapshotWithoutReason).success).toBe(false);
    const attachSchema = TOOL_DEFINITIONS.find(({ name }) => name === "unity_debug_attach")!.successSchema;
    expect(attachSchema.safeParse({
      ...SUCCESS_CASES.unity_debug_attach.result,
      session: { sessionRef: "opaque-session", tracked: false },
    }).success).toBe(false);
  });

  it("validates normalized event output by UTF-8 byte length", async () => {
    const exactBoundary = `${"界".repeat(21_845)}a`;
    const overBoundary = "界".repeat(21_846);
    expect(Buffer.byteLength(exactBoundary, "utf8")).toBe(65_536);
    expect(Buffer.byteLength(overBoundary, "utf8")).toBeGreaterThan(65_536);

    const waitSchema = TOOL_DEFINITIONS.find(({ name }) =>
      name === "unity_debug_wait_for_event"
    )!.successSchema;
    expect(waitSchema.safeParse({
      ...METADATA,
      event: { sequence: 5, kind: "output", output: exactBoundary },
    }).success).toBe(true);
    expect(waitSchema.safeParse({
      ...METADATA,
      event: { sequence: 5, kind: "reload-progress", output: overBoundary },
    }).success).toBe(false);

    const bridge = {
      callTool: vi.fn().mockResolvedValue({
        ...METADATA,
        event: { sequence: 5, kind: "output", output: overBoundary },
      }),
    } satisfies BridgeToolCaller;
    const { client } = await connect(bridge);
    await client.listTools();

    const result = await client.callTool({
      name: "unity_debug_wait_for_event",
      arguments: { afterSequence: 4 },
    });
    const serialized = JSON.stringify(result);
    expect(bridge.callTool).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { code: "DAP_FAILURE" },
    });
    expect(serialized).not.toContain("界界界界界界界界");
  });

  it("maps BridgeCallError.detail exactly to a structured MCP error", async () => {
    const detail = Object.freeze({
      code: "NOT_STOPPED" as const,
      message: "The debugger session is not stopped at an inspectable generation.",
      retryable: true,
      currentState: "not_stopped",
      action: "Wait for a stopped event, then request fresh debugger data.",
    });
    const bridge = {
      callTool: vi.fn().mockRejectedValue(new BridgeCallError(detail)),
    } satisfies BridgeToolCaller;
    const { client } = await connect(bridge);
    await client.listTools();

    const result = await client.callTool({ name: "unity_debug_threads", arguments: {} });

    expect(bridge.callTool).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual(detail);
    expect(result.content).toEqual([{
      type: "text",
      text: "NOT_STOPPED: The debugger session is not stopped at an inspectable generation.",
    }]);
  });

  it("rejects unknown or raw bridge output as one sanitized DAP_FAILURE", async () => {
    const bridge = {
      callTool: vi.fn().mockResolvedValue({
        sessionRef: "opaque-session",
        state: "stopped",
        stopGeneration: 2,
        eventSequence: 4,
        threads: [{ threadRef: "opaque-thread", name: "Main", threadId: 9347 }],
        privateExpression: "ApplyDamage(secret)",
      }),
    } satisfies BridgeToolCaller;
    const { client } = await connect(bridge);
    await client.listTools();

    const result = await client.callTool({ name: "unity_debug_threads", arguments: {} });
    const serialized = JSON.stringify(result);

    expect(bridge.callTool).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { code: "DAP_FAILURE" },
    });
    expect(serialized).not.toContain("9347");
    expect(serialized).not.toContain("ApplyDamage");
    expect(serialized).not.toContain("privateExpression");
  });

  it("sanitizes SDK input-validation failures before any bridge call", async () => {
    const bridge: BridgeToolCaller = { callTool: vi.fn() };
    const { client } = await connect(bridge);
    await client.listTools();

    const result = await client.callTool({
      name: "unity_debug_stack_trace",
      arguments: { threadId: 9347, expression: "ApplyDamage(secret)" },
    });
    const serialized = JSON.stringify(result);

    expect(bridge.callTool).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { code: "DAP_FAILURE" },
    });
    expect(serialized).not.toContain("9347");
    expect(serialized).not.toContain("ApplyDamage");
    expect(serialized).not.toContain("threadRef");
    expect(serialized).not.toContain("Zod");
  });

  it("keeps variables and snapshot text summaries short instead of copying payloads", async () => {
    const huge = "v".repeat(4_096);
    const bridge = {
      callTool: vi.fn().mockResolvedValue({
        sessionRef: "opaque-session",
        state: "stopped",
        stopGeneration: 2,
        eventSequence: 4,
        variables: Array.from({ length: 100 }, (_, index) => ({
          name: `value-${index}`,
          value: huge,
        })),
      }),
    } satisfies BridgeToolCaller;
    const { client } = await connect(bridge);

    const result = await client.callTool({
      name: "unity_debug_variables",
      arguments: { variablesRef: "opaque-variables" },
    });

    const text = ((result as { content: readonly { text: string }[] }).content[0]!).text;
    expect(text.length).toBeLessThanOrEqual(256);
    expect(text).not.toContain(huge);
    expect(text).toBe("Returned 100 debugger variables.");
  });
});
