import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  McpStdioServerDefinition: class McpStdioServerDefinition {
    public readonly label: string;
    public command: string;
    public args: string[];
    public env: Record<string, string | number | null>;
    public version: string | undefined;

    public constructor(
      label: string,
      command: string,
      args: string[] = [],
      env: Record<string, string | number | null> = {},
      version?: string,
    ) {
      this.label = label;
      this.command = command;
      this.args = args;
      this.env = env;
      this.version = version;
    }
  },
}));

import type * as vscode from "vscode";

import {
  createMcpProvider,
  MCP_PROVIDER_ID,
  type McpProviderOptions,
} from "../../src/mcpProvider.js";

const PIPE_NAME = "\\\\.\\pipe\\unity-debugger-pure-mcp-provider-fixture";
const TOKEN = Buffer.alloc(32, 0x2a).toString("base64url");
const EXECUTABLE = "D:\\extension\\dist\\mcp-bridge.exe";
const WORKSPACES = Object.freeze([
  "H:\\workspace\\Unity\\Tuanjie\\Projects\\MyGame",
  "D:\\Unity\\OtherProject",
]);

function cancellationToken(cancelled = false): vscode.CancellationToken {
  return {
    isCancellationRequested: cancelled,
    onCancellationRequested: (() => ({ dispose() {} })) as vscode.Event<unknown>,
  };
}

function harness(overrides: Partial<McpProviderOptions> = {}) {
  const ensureDebuggerApi = vi.fn(async () => undefined);
  const isWorkspaceTrusted = vi.fn(() => true);
  const statExecutable = vi.fn(async () => ({ isFile: () => true }));
  const options: McpProviderOptions = {
    executable: EXECUTABLE,
    descriptor: Object.freeze({ protocolVersion: 1, pipeName: PIPE_NAME, token: TOKEN }),
    workspaceRoots: WORKSPACES,
    version: "0.1.0",
    ensureDebuggerApi,
    isWorkspaceTrusted,
    statExecutable,
    ...overrides,
  };
  return {
    provider: createMcpProvider(options),
    ensureDebuggerApi,
    isWorkspaceTrusted,
    statExecutable,
  };
}

describe("MCP definition provider", () => {
  it("publishes one canonical stdio definition without validation side effects", async () => {
    const { provider, ensureDebuggerApi, isWorkspaceTrusted, statExecutable } = harness();

    const definitions = await provider.provideMcpServerDefinitions(cancellationToken(false));

    expect(MCP_PROVIDER_ID).toBe("unity-debugger-pure-mcp.server");
    expect(definitions).toHaveLength(1);
    expect(definitions?.[0]).toEqual({
      label: "Unity Debugger Pure MCP",
      command: EXECUTABLE,
      args: [
        "--pipe", PIPE_NAME,
        "--token", TOKEN,
        "--workspace", WORKSPACES[0],
        "--workspace", WORKSPACES[1],
      ],
      env: {},
      version: "0.1.0",
    });
    expect(ensureDebuggerApi).not.toHaveBeenCalled();
    expect(isWorkspaceTrusted).not.toHaveBeenCalled();
    expect(statExecutable).not.toHaveBeenCalled();
  });

  it("resolves only the canonical definition after fail-closed validation", async () => {
    const { provider, ensureDebuggerApi, isWorkspaceTrusted, statExecutable } = harness();
    const [definition] = await provider.provideMcpServerDefinitions(cancellationToken(false)) ?? [];

    const resolved = await provider.resolveMcpServerDefinition!(
      definition!,
      cancellationToken(false),
    );

    expect(resolved).toEqual(definition);
    expect(isWorkspaceTrusted).toHaveBeenCalledTimes(1);
    expect(ensureDebuggerApi).toHaveBeenCalledTimes(1);
    expect(statExecutable).toHaveBeenCalledWith(EXECUTABLE);
  });

  it("returns no eager definition after cancellation", async () => {
    const { provider, ensureDebuggerApi, statExecutable } = harness();
    expect(await provider.provideMcpServerDefinitions(cancellationToken(true))).toEqual([]);
    expect(ensureDebuggerApi).not.toHaveBeenCalled();
    expect(statExecutable).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "cancelled resolution",
      override: {},
      mutate: undefined,
      cancelled: true,
    },
    {
      name: "untrusted workspace",
      override: { isWorkspaceTrusted: () => false },
      mutate: undefined,
      cancelled: false,
    },
    {
      name: "incompatible debugger API",
      override: { ensureDebuggerApi: async () => { throw new Error(`secret ${TOKEN}`); } },
      mutate: undefined,
      cancelled: false,
    },
    {
      name: "missing executable",
      override: { statExecutable: async () => { throw new Error(EXECUTABLE); } },
      mutate: undefined,
      cancelled: false,
    },
    {
      name: "non-file executable",
      override: { statExecutable: async () => ({ isFile: () => false }) },
      mutate: undefined,
      cancelled: false,
    },
    {
      name: "tampered command",
      override: {},
      mutate: (definition: vscode.McpStdioServerDefinition) => {
        definition.command = "powershell.exe";
      },
      cancelled: false,
    },
    {
      name: "tampered capability",
      override: {},
      mutate: (definition: vscode.McpStdioServerDefinition) => {
        definition.args[3] = "forged-token";
      },
      cancelled: false,
    },
  ])("rejects $name without reflecting descriptor values", async ({ override, mutate, cancelled }) => {
    const { provider } = harness(override as Partial<McpProviderOptions>);
    const [definition] = await provider.provideMcpServerDefinitions(cancellationToken(false)) ?? [];
    mutate?.(definition!);

    let message = "";
    try {
      await provider.resolveMcpServerDefinition!(definition!, cancellationToken(cancelled));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain(PIPE_NAME);
    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain(EXECUTABLE);
  });
});
