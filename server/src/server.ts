import path from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { cancelledError } from "../../src/tools/errors.js";
import { BridgeCallError, BridgeClient } from "./bridgeClient.js";
import { LiveHostRegistry } from "./liveHostRegistry.js";
import { RegistryBridgeClient } from "./registryBridgeClient.js";
import {
  createUnityDebuggerMcpServer,
  type BridgeToolCaller,
} from "./toolCatalog.js";

const INVALID_ARGUMENTS_MESSAGE = "Invalid MCP server arguments.";
const HELP_TEXT = [
  "Unity Debugger Pure MCP",
  "Usage: mcp-bridge --pipe <named-pipe> --token <capability> [--workspace <root>]...",
  "       mcp-bridge --registry <runtime-root> --client-root <canonical-root>",
  "All diagnostics are written to stderr; stdout is reserved for MCP JSON-RPC.",
  "",
].join("\n");

export type ServerCliOptions =
  | Readonly<{
      readonly mode: "direct";
      readonly pipeName: string;
      readonly token: string;
      readonly workspaceRoots: readonly string[];
    }>
  | Readonly<{
      readonly mode: "registry";
      readonly runtimeRoot: string;
      readonly clientRoot: string;
    }>;

export type ParsedServerArgs =
  | Readonly<{ readonly kind: "help" }>
  | Readonly<{ readonly kind: "run"; readonly options: ServerCliOptions }>;

type DirectServerCliOptions = Extract<ServerCliOptions, { readonly mode: "direct" }>;
type RegistryServerCliOptions = Extract<ServerCliOptions, { readonly mode: "registry" }>;
type ClosableBridge = BridgeToolCaller & { close(): void };
interface ServerInstance {
  readonly server: { onclose?: () => void };
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
}

interface ServerInput {
  once(event: "end", listener: () => void): unknown;
  removeListener(event: "end", listener: () => void): unknown;
}

export interface ServerRunDependencies {
  readonly stdin: ServerInput;
  readonly signal?: AbortSignal;
  readonly connectDirect: (options: DirectServerCliOptions) => Promise<ClosableBridge>;
  readonly connectRegistry: (options: RegistryServerCliOptions) => Promise<ClosableBridge>;
  readonly createServer: (bridge: BridgeToolCaller) => ServerInstance;
  readonly createTransport: () => Transport;
}

const DEFAULT_DEPENDENCIES: ServerRunDependencies = Object.freeze({
  stdin: process.stdin,
  connectDirect: async (options: DirectServerCliOptions) => BridgeClient.connect({
    protocolVersion: 1,
    pipeName: options.pipeName,
    token: options.token,
  }),
  connectRegistry: async (options: RegistryServerCliOptions) => RegistryBridgeClient.connect(
    new LiveHostRegistry({
      runtimeRoot: options.runtimeRoot,
      clientRoot: options.clientRoot,
      runningExecutable: process.execPath,
    }),
  ),
  createServer: createUnityDebuggerMcpServer,
  createTransport: () => new StdioServerTransport(),
});

export function parseServerArgs(args: readonly string[]): ParsedServerArgs {
  if (args.length === 1 && args[0] === "--help") {
    return Object.freeze({ kind: "help" });
  }

  let pipeName: string | undefined;
  let token: string | undefined;
  let runtimeRoot: string | undefined;
  let clientRoot: string | undefined;
  const workspaceRoots: string[] = [];
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined || value.length === 0) {
      throw invalidArguments();
    }
    switch (flag) {
      case "--pipe":
        if (pipeName !== undefined) {
          throw invalidArguments();
        }
        pipeName = value;
        break;
      case "--token":
        if (token !== undefined) {
          throw invalidArguments();
        }
        token = value;
        break;
      case "--workspace":
        if (value.length > 4_096) {
          throw invalidArguments();
        }
        workspaceRoots.push(value);
        break;
      case "--registry":
        if (runtimeRoot !== undefined || value.length > 4_096) {
          throw invalidArguments();
        }
        runtimeRoot = value;
        break;
      case "--client-root":
        if (clientRoot !== undefined || value.length > 4_096) {
          throw invalidArguments();
        }
        clientRoot = value;
        break;
      default:
        throw invalidArguments();
    }
  }

  const directMode = pipeName !== undefined || token !== undefined || workspaceRoots.length > 0;
  const registryMode = runtimeRoot !== undefined || clientRoot !== undefined;
  if (directMode === registryMode) {
    throw invalidArguments();
  }
  if (directMode) {
    if (
      pipeName === undefined ||
      token === undefined ||
      !validPipeName(pipeName) ||
      !validToken(token)
    ) {
      throw invalidArguments();
    }
    return Object.freeze({
      kind: "run",
      options: Object.freeze({
        mode: "direct",
        pipeName,
        token,
        workspaceRoots: Object.freeze(workspaceRoots),
      }),
    });
  }
  if (runtimeRoot === undefined || clientRoot === undefined) {
    throw invalidArguments();
  }
  return Object.freeze({
    kind: "run",
    options: Object.freeze({
      mode: "registry",
      runtimeRoot,
      clientRoot,
    }),
  });
}

export async function runServer(
  args: readonly string[],
  dependencyOverrides: Partial<ServerRunDependencies> = {},
): Promise<void> {
  const parsed = parseServerArgs(args);
  if (parsed.kind === "help") {
    process.stderr.write(HELP_TEXT);
    return;
  }

  const dependencies: ServerRunDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...dependencyOverrides,
  };
  let bridge: ClosableBridge | undefined;
  let server: ServerInstance | undefined;
  let closeOnStdinEnd: (() => void) | undefined;
  let closeOnAbort: (() => void) | undefined;
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    if (closeOnStdinEnd !== undefined) {
      dependencies.stdin.removeListener("end", closeOnStdinEnd);
    }
    if (closeOnAbort !== undefined) {
      dependencies.signal?.removeEventListener("abort", closeOnAbort);
    }
    bridge?.close();
    bridge = undefined;
  };
  const closeServer = (): void => {
    if (server === undefined) {
      cleanup();
      return;
    }
    void server.close().then(cleanup, cleanup);
  };
  try {
    if (isAborted(dependencies.signal)) {
      throw new BridgeCallError(cancelledError());
    }
    bridge = parsed.options.mode === "direct"
      ? await dependencies.connectDirect(parsed.options)
      : await dependencies.connectRegistry(parsed.options);
    if (isAborted(dependencies.signal)) {
      throw new BridgeCallError(cancelledError());
    }
    server = dependencies.createServer(bridge);
    closeOnStdinEnd = closeServer;
    closeOnAbort = closeServer;
    dependencies.stdin.once("end", closeOnStdinEnd);
    dependencies.signal?.addEventListener("abort", closeOnAbort, { once: true });
    server.server.onclose = () => {
      cleanup();
    };
    await server.connect(dependencies.createTransport());
  } catch (error) {
    if (server !== undefined) {
      await server.close().catch(() => undefined);
    }
    cleanup();
    throw error;
  }
}

function validPipeName(value: string): boolean {
  return value.startsWith("\\\\.\\pipe\\unity-debugger-pure-mcp-") &&
    value.length <= 512;
}

function validToken(value: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    return false;
  }
  try {
    return Buffer.from(value, "base64url").byteLength === 32;
  } catch {
    return false;
  }
}

function invalidArguments(): Error {
  return new Error(INVALID_ARGUMENTS_MESSAGE);
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isDirectEntry(): boolean {
  return (
    typeof __filename === "string" &&
    process.argv[1] !== undefined &&
    path.resolve(process.argv[1]) === path.resolve(__filename)
  );
}

if (isDirectEntry()) {
  void runServer(process.argv.slice(2)).catch(() => {
    process.stderr.write(
      "Unity Debugger Pure MCP failed: the local debugger bridge is unavailable.\n",
    );
    process.exitCode = 1;
  });
}
