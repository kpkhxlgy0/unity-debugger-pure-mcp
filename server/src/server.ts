import path from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { BridgeClient } from "./bridgeClient.js";
import { createUnityDebuggerMcpServer } from "./toolCatalog.js";

const INVALID_ARGUMENTS_MESSAGE = "Invalid MCP server arguments.";
const HELP_TEXT = [
  "Unity Debugger Pure MCP",
  "Usage: mcp-bridge --pipe <named-pipe> --token <capability> [--workspace <root>]...",
  "All diagnostics are written to stderr; stdout is reserved for MCP JSON-RPC.",
  "",
].join("\n");

export interface ServerCliOptions {
  readonly pipeName: string;
  readonly token: string;
  readonly workspaceRoots: readonly string[];
}

export type ParsedServerArgs =
  | Readonly<{ readonly kind: "help" }>
  | Readonly<{ readonly kind: "run"; readonly options: ServerCliOptions }>;

export function parseServerArgs(args: readonly string[]): ParsedServerArgs {
  if (args.length === 1 && args[0] === "--help") {
    return Object.freeze({ kind: "help" });
  }

  let pipeName: string | undefined;
  let token: string | undefined;
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
      default:
        throw invalidArguments();
    }
  }

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
      pipeName,
      token,
      workspaceRoots: Object.freeze(workspaceRoots),
    }),
  });
}

export async function runServer(args: readonly string[]): Promise<void> {
  const parsed = parseServerArgs(args);
  if (parsed.kind === "help") {
    process.stderr.write(HELP_TEXT);
    return;
  }

  let bridge: BridgeClient | undefined;
  let closeOnStdinEnd: (() => void) | undefined;
  try {
    bridge = await BridgeClient.connect({
      protocolVersion: 1,
      pipeName: parsed.options.pipeName,
      token: parsed.options.token,
    });
    const server = createUnityDebuggerMcpServer(bridge);
    closeOnStdinEnd = (): void => {
      void server.close().catch(() => {
        bridge?.close();
        bridge = undefined;
      });
    };
    process.stdin.once("end", closeOnStdinEnd);
    server.server.onclose = () => {
      if (closeOnStdinEnd !== undefined) {
        process.stdin.removeListener("end", closeOnStdinEnd);
      }
      bridge?.close();
      bridge = undefined;
    };
    await server.connect(new StdioServerTransport());
  } catch (error) {
    if (closeOnStdinEnd !== undefined) {
      process.stdin.removeListener("end", closeOnStdinEnd);
    }
    bridge?.close();
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
