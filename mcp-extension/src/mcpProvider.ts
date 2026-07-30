import { stat } from "node:fs/promises";

import * as vscode from "vscode";

import type { BridgeDescriptor } from "./bridge/bridgeHost.js";

export const MCP_PROVIDER_ID = "unity-debugger-pure-mcp.server";
const MCP_LABEL = "Unity Debugger Pure MCP";

interface FileStatus {
  isFile(): boolean;
}

export interface McpProviderOptions {
  readonly executable: string;
  readonly descriptor: BridgeDescriptor;
  readonly workspaceRoots: readonly string[];
  readonly version: string;
  readonly ensureDebuggerApi: () => Promise<unknown>;
  readonly isWorkspaceTrusted: () => boolean;
  readonly statExecutable?: (executable: string) => Promise<FileStatus>;
}

export function createMcpProvider(
  options: McpProviderOptions,
): vscode.McpServerDefinitionProvider<vscode.McpStdioServerDefinition> {
  validateOptions(options);
  const expectedArgs = Object.freeze(descriptorArgs(
    options.descriptor,
    options.workspaceRoots,
  ));
  const issued = new WeakSet<vscode.McpStdioServerDefinition>();
  const createDefinition = (): vscode.McpStdioServerDefinition => {
    const definition = new vscode.McpStdioServerDefinition(
      MCP_LABEL,
      options.executable,
      [...expectedArgs],
      {},
      options.version,
    );
    issued.add(definition);
    return definition;
  };
  const statFile = options.statExecutable ?? stat;

  return Object.freeze({
    provideMcpServerDefinitions(token: vscode.CancellationToken) {
      return token.isCancellationRequested ? [] : [createDefinition()];
    },
    async resolveMcpServerDefinition(
      server: vscode.McpStdioServerDefinition,
      token: vscode.CancellationToken,
    ) {
      if (token.isCancellationRequested) {
        throw new Error("The MCP server request was cancelled.");
      }
      if (!issued.has(server) || !isCanonicalDefinition(
        server,
        options.executable,
        expectedArgs,
        options.version,
      )) {
        throw new Error("The MCP server definition is invalid.");
      }
      let trusted = false;
      try {
        trusted = options.isWorkspaceTrusted();
      } catch {
        trusted = false;
      }
      if (!trusted) {
        throw new Error("The MCP debugger requires a trusted workspace.");
      }
      try {
        await options.ensureDebuggerApi();
      } catch {
        throw new Error("The Unity debugger API is unavailable or incompatible.");
      }
      try {
        const status = await statFile(options.executable);
        if (!status.isFile()) {
          throw new Error("not a file");
        }
      } catch {
        throw new Error("The packaged MCP bridge executable is unavailable.");
      }
      if (token.isCancellationRequested) {
        throw new Error("The MCP server request was cancelled.");
      }
      return createDefinition();
    },
  });
}

function descriptorArgs(
  descriptor: BridgeDescriptor,
  workspaceRoots: readonly string[],
): string[] {
  const args = [
    "--pipe",
    descriptor.pipeName,
    "--token",
    descriptor.token,
  ];
  for (const root of workspaceRoots) {
    args.push("--workspace", root);
  }
  return args;
}

function isCanonicalDefinition(
  definition: vscode.McpStdioServerDefinition,
  executable: string,
  expectedArgs: readonly string[],
  version: string,
): boolean {
  try {
    return definition.label === MCP_LABEL &&
      definition.command === executable &&
      definition.version === version &&
      definition.args.length === expectedArgs.length &&
      definition.args.every((value, index) => value === expectedArgs[index]) &&
      Object.keys(definition.env).length === 0;
  } catch {
    return false;
  }
}

function validateOptions(options: McpProviderOptions): void {
  if (
    options.executable.length === 0 ||
    options.version.length === 0 ||
    options.descriptor.protocolVersion !== 1 ||
    options.descriptor.pipeName.length === 0 ||
    options.descriptor.token.length === 0 ||
    options.workspaceRoots.some((root) => root.length === 0)
  ) {
    throw new Error("Invalid MCP provider configuration.");
  }
}
