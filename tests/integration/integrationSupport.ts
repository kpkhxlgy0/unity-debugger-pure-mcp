import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect } from "vitest";

import type { BridgeDescriptor } from "../../src/bridge/bridgeHost.js";
import type { ToolName } from "../../src/bridge/protocol.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const launcherRoot = path.join(repositoryRoot, "launcher");
const bridgeExecutable = path.join(repositoryRoot, "dist", "mcp-bridge.exe");
let buildComplete = false;

export async function ensureSeaBuilt(): Promise<void> {
  if (buildComplete) {
    return;
  }
  const result = spawnSync(process.execPath, [
    path.join(repositoryRoot, "scripts", "build-mcp-bridge.mjs"),
  ], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  buildComplete = true;
}

export async function writeRegistration(options: {
  readonly localAppData: string;
  readonly workspace: string;
  readonly descriptor: BridgeDescriptor;
  readonly registrationPath?: string;
}): Promise<string> {
  const runtimeRoot = runtimeRegistryRoot(options.localAppData);
  await fs.mkdir(runtimeRoot, { recursive: true });
  const [canonicalWorkspace, canonicalExtension, canonicalExecutable] = await Promise.all([
    fs.realpath(options.workspace),
    fs.realpath(repositoryRoot),
    fs.realpath(bridgeExecutable),
  ]);
  const instanceId = randomUUID();
  const registrationPath = options.registrationPath ?? path.join(runtimeRoot, `${instanceId}.json`);
  const temporaryPath = path.join(runtimeRoot, `.${randomUUID()}.tmp`);
  const sha256 = await fileSha256(canonicalExecutable);
  await fs.writeFile(temporaryPath, JSON.stringify({
    schemaVersion: 1,
    instanceId,
    ownerPid: process.pid,
    updatedAt: new Date().toISOString(),
    workspaceRoots: [canonicalWorkspace],
    bridge: {
      version: "0.1.0",
      protocolVersion: 1,
      extensionRoot: canonicalExtension,
      executable: canonicalExecutable,
      sha256,
    },
    pipe: {
      name: options.descriptor.pipeName,
      token: options.descriptor.token,
    },
  }));
  await fs.rename(temporaryPath, registrationPath);
  return registrationPath;
}

export function createExternalTransport(options: {
  readonly workspace: string;
  readonly localAppData: string;
}): StdioClientTransport {
  const wheel = process.env.MCP_LAUNCHER_WHEEL;
  return new StdioClientTransport({
    command: wheel === undefined ? "uv" : "uvx",
    args: wheel === undefined
      ? [
          "run",
          "--project",
          launcherRoot,
          "--locked",
          "--python",
          "3.10",
          "unity-debugger-pure-mcp",
        ]
      : ["--from", wheel, "unity-debugger-pure-mcp"],
    cwd: options.workspace,
    env: childEnvironment(options.localAppData),
    stderr: "pipe",
  });
}

export function createDirectTransport(options: {
  readonly workspace: string;
  readonly descriptor: BridgeDescriptor;
}): StdioClientTransport {
  return new StdioClientTransport({
    command: bridgeExecutable,
    args: [
      "--pipe",
      options.descriptor.pipeName,
      "--token",
      options.descriptor.token,
      "--workspace",
      options.workspace,
    ],
    cwd: options.workspace,
    stderr: "pipe",
  });
}

export function createRegistryTransport(options: {
  readonly workspace: string;
  readonly localAppData: string;
  readonly registrationPath: string;
}): StdioClientTransport {
  return new StdioClientTransport({
    command: bridgeExecutable,
    args: [
      "--registry",
      path.dirname(options.registrationPath),
      "--client-root",
      options.workspace,
    ],
    cwd: options.workspace,
    env: childEnvironment(options.localAppData),
    stderr: "pipe",
  });
}

export async function success(
  client: Client,
  name: ToolName,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  const response = result as {
    readonly isError?: boolean;
    readonly structuredContent?: Record<string, unknown>;
  };
  expect(response.isError, `${name}: ${JSON.stringify(result)}`).not.toBe(true);
  expect(response.structuredContent).toBeDefined();
  return response.structuredContent!;
}

export async function toolError(
  client: Client,
  name: ToolName,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  const response = result as {
    readonly isError?: boolean;
    readonly structuredContent?: Record<string, unknown>;
  };
  expect(response.isError).toBe(true);
  expect(response.structuredContent).toMatchObject({
    code: expect.any(String),
    message: expect.any(String),
    retryable: expect.any(Boolean),
    currentState: expect.any(String),
    action: expect.any(String),
  });
  return response.structuredContent!;
}

export async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the integration condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function waitForProcessExit(pid: number | null): Promise<void> {
  if (pid === null) {
    throw new Error("The integration transport did not expose a child PID.");
  }
  await waitFor(() => !processAlive(pid));
}

function runtimeRegistryRoot(localAppData: string): string {
  return path.join(
    localAppData,
    "kpk",
    "unity-debugger-pure-mcp",
    "runtime",
    "v1",
  );
}

function childEnvironment(localAppData: string): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string"),
  );
  return {
    ...environment,
    LOCALAPPDATA: localAppData,
    UV_LINK_MODE: "copy",
    UV_NO_PROGRESS: "1",
  };
}

async function fileSha256(file: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
