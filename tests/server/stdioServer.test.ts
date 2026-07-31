import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { BridgeHost } from "../../src/bridge/bridgeHost.js";
import { TOOL_NAMES } from "../../src/bridge/protocol.js";
import {
  parseServerArgs,
  runServer,
  type ServerCliOptions,
} from "../../server/src/server.js";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../..");
const BUNDLED_ENTRY = path.join(REPOSITORY_ROOT, "server", "dist", "server.cjs");
const children = new Set<ChildProcessWithoutNullStreams>();
const hosts = new Set<BridgeHost>();

beforeAll(() => {
  const built = spawnSync(process.execPath, ["esbuild.mjs"], {
    cwd: path.join(REPOSITORY_ROOT, "server"),
    encoding: "utf8",
  });
  expect(built.status, `${built.stdout}\n${built.stderr}`).toBe(0);
}, 30_000);

afterEach(async () => {
  for (const child of children) {
    child.stdin.end();
    child.kill();
  }
  children.clear();
  await Promise.all([...hosts].map((host) => host.close()));
  hosts.clear();
});

function fixtureOptions(): Extract<ServerCliOptions, { readonly mode: "direct" }> {
  return Object.freeze({
    mode: "direct",
    pipeName: "\\\\.\\pipe\\unity-debugger-pure-mcp-00000000-0000-4000-8000-000000000000",
    token: Buffer.alloc(32, 7).toString("base64url"),
    workspaceRoots: Object.freeze(["H:\\workspace\\Unity\\Tuanjie\\Projects\\MyGame"]),
  });
}

function registryArgs(): string[] {
  return [
    "--registry", "C:\\Users\\fixture\\AppData\\Local\\kpk\\unity-debugger-pure-mcp\\runtime\\v1",
    "--client-root", "D:\\Unity\\Project",
  ];
}

function runHarness(options: { readonly connectFailure?: boolean } = {}) {
  const stdin = new EventEmitter();
  const directBridge = { callTool: vi.fn(), close: vi.fn() };
  const registryBridge = { callTool: vi.fn(), close: vi.fn() };
  const protocol = { onclose: undefined as (() => void) | undefined };
  const server = {
    server: protocol,
    connect: vi.fn(async () => {
      if (options.connectFailure) {
        throw new Error("private startup failure");
      }
    }),
    close: vi.fn(async () => {
      protocol.onclose?.();
    }),
  };
  const dependencies = {
    stdin,
    signal: undefined as AbortSignal | undefined,
    connectDirect: vi.fn(async () => directBridge),
    connectRegistry: vi.fn(async () => registryBridge),
    createServer: vi.fn(() => server),
    createTransport: vi.fn(() => ({ marker: "transport" } as never)),
  };
  return { dependencies, directBridge, protocol, registryBridge, server, stdin };
}

describe("MCP stdio server", () => {
  it("parses Task 8 descriptor arguments without reflecting singleton values", () => {
    const expected = fixtureOptions();
    expect(parseServerArgs([
      "--pipe", expected.pipeName,
      "--token", expected.token,
      "--workspace", expected.workspaceRoots[0]!,
      "--workspace", "D:\\Unity\\OtherProject",
    ])).toEqual({
      kind: "run",
      options: {
        ...expected,
        workspaceRoots: [expected.workspaceRoots[0], "D:\\Unity\\OtherProject"],
      },
    });

    for (const args of [
      ["--pipe", expected.pipeName, "--pipe", expected.pipeName, "--token", expected.token],
      ["--pipe", expected.pipeName, "--token", expected.token, "--mystery", "secret"],
      ["--pipe", expected.pipeName, "--token"],
      ["--token", expected.token],
    ]) {
      expect(() => parseServerArgs(args)).toThrow("Invalid MCP server arguments.");
    }
    expect(parseServerArgs(["--help"])).toEqual({ kind: "help" });
  });

  it("parses registry mode without accepting a capability on argv", () => {
    expect(parseServerArgs([
      "--registry", "C:\\Users\\fixture\\AppData\\Local\\kpk\\unity-debugger-pure-mcp\\runtime\\v1",
      "--client-root", "D:\\Unity\\Project",
    ])).toEqual({
      kind: "run",
      options: {
        mode: "registry",
        runtimeRoot: "C:\\Users\\fixture\\AppData\\Local\\kpk\\unity-debugger-pure-mcp\\runtime\\v1",
        clientRoot: "D:\\Unity\\Project",
      },
    });
  });

  it.each([
    ["mixed direct and registry", [
      "--pipe", fixtureOptions().pipeName,
      "--token", fixtureOptions().token,
      "--registry", "C:\\runtime",
      "--client-root", "D:\\project",
    ]],
    ["workspace in registry mode", [
      "--registry", "C:\\runtime",
      "--client-root", "D:\\project",
      "--workspace", "D:\\project",
    ]],
    ["registry without client root", ["--registry", "C:\\runtime"]],
    ["client root without registry", ["--client-root", "D:\\project"]],
    ["duplicate registry", [
      "--registry", "C:\\runtime",
      "--registry", "C:\\runtime",
      "--client-root", "D:\\project",
    ]],
    ["duplicate client root", [
      "--registry", "C:\\runtime",
      "--client-root", "D:\\project",
      "--client-root", "D:\\project",
    ]],
    ["empty registry", ["--registry", "", "--client-root", "D:\\project"]],
    ["overlong registry", ["--registry", "x".repeat(4_097), "--client-root", "D:\\project"]],
    ["overlong client root", ["--registry", "C:\\runtime", "--client-root", "x".repeat(4_097)]],
  ])("rejects %s", (_name, args) => {
    expect(() => parseServerArgs(args)).toThrow("Invalid MCP server arguments.");
  });

  it("selects direct and registry bridge factories without changing provider argv", async () => {
    const direct = runHarness();
    const options = fixtureOptions();
    await runServer([
      "--pipe", options.pipeName,
      "--token", options.token,
      "--workspace", options.workspaceRoots[0]!,
    ], direct.dependencies);
    expect(direct.dependencies.connectDirect).toHaveBeenCalledWith(options);
    expect(direct.dependencies.connectRegistry).not.toHaveBeenCalled();

    const registry = runHarness();
    await runServer(registryArgs(), registry.dependencies);
    expect(registry.dependencies.connectRegistry).toHaveBeenCalledWith({
      mode: "registry",
      runtimeRoot: registryArgs()[1],
      clientRoot: registryArgs()[3],
    });
    expect(registry.dependencies.connectDirect).not.toHaveBeenCalled();
    expect(registryArgs()).not.toContain(options.token);
  });

  it("closes the selected bridge on stdin EOF and MCP close", async () => {
    const eof = runHarness();
    await runServer(registryArgs(), eof.dependencies);
    eof.stdin.emit("end");
    await vi.waitFor(() => expect(eof.server.close).toHaveBeenCalledOnce());
    expect(eof.registryBridge.close).toHaveBeenCalledOnce();

    const protocolClose = runHarness();
    await runServer(registryArgs(), protocolClose.dependencies);
    protocolClose.protocol.onclose?.();
    expect(protocolClose.registryBridge.close).toHaveBeenCalledOnce();
  });

  it("closes the bridge when MCP startup fails or startup is cancelled", async () => {
    const failed = runHarness({ connectFailure: true });
    await expect(runServer(registryArgs(), failed.dependencies)).rejects.toThrow(
      "private startup failure",
    );
    expect(failed.registryBridge.close).toHaveBeenCalledOnce();

    const cancelled = runHarness();
    const controller = new AbortController();
    cancelled.dependencies.signal = controller.signal;
    await runServer(registryArgs(), cancelled.dependencies);
    controller.abort();
    await vi.waitFor(() => expect(cancelled.server.close).toHaveBeenCalledOnce());
    expect(cancelled.registryBridge.close).toHaveBeenCalledOnce();
  });

  it("keeps bundled --help stdout completely empty", () => {
    const result = spawnSync(process.execPath, [BUNDLED_ENTRY, "--help"], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unity Debugger Pure MCP");
  });

  it("writes sanitized startup failures only to stderr", () => {
    const options = fixtureOptions();
    const result = spawnSync(process.execPath, [
      BUNDLED_ENTRY,
      "--pipe", options.pipeName,
      "--token", options.token,
    ], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      timeout: 5_000,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Unity Debugger Pure MCP failed: the local debugger bridge is unavailable.\n");
    expect(result.stderr).not.toContain(options.pipeName);
    expect(result.stderr).not.toContain(options.token);
  });

  it("builds and spawns the bundle with pure line-delimited JSON-RPC stdout", async () => {
    const host = new BridgeHost({
      handler: {
        callTool: async () => ({
          session: null,
          state: "not-attached",
          eventSequence: 0,
        }),
      },
    });
    hosts.add(host);
    const descriptor = await host.listen();
    const child = spawn(process.execPath, [
      BUNDLED_ENTRY,
      "--pipe", descriptor.pipeName,
      "--token", descriptor.token,
      "--workspace", "H:\\workspace\\Unity\\Tuanjie\\Projects\\MyGame",
    ], {
      cwd: REPOSITORY_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.add(child);

    const stdoutLines: string[] = [];
    let stdoutBuffer = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      while (stdoutBuffer.includes("\n")) {
        const newline = stdoutBuffer.indexOf("\n");
        const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line.length > 0) {
          stdoutLines.push(line);
        }
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "stdio-test", version: "1.0.0" },
      },
    })}\n`);
    await waitFor(() => stdoutLines.some((line) => JSON.parse(line).id === 1));
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    })}\n`);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    })}\n`);
    await waitFor(() => stdoutLines.some((line) => JSON.parse(line).id === 2));
    child.stdin.end();
    await waitForExit(child);
    children.delete(child);

    expect(stdoutBuffer).toBe("");
    const messages = stdoutLines.map((line) => JSON.parse(line) as {
      readonly id?: number;
      readonly result?: { readonly tools?: readonly { readonly name: string }[] };
    });
    expect(messages.every((message) => typeof message === "object" && message !== null)).toBe(true);
    expect(messages.find(({ id }) => id === 1)?.result).toBeDefined();
    expect(messages.find(({ id }) => id === 2)?.result?.tools?.map(({ name }) => name)).toEqual([...TOOL_NAMES]);
    expect(stderr).toBe("");
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for bundled MCP stdout.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timed out waiting for bundled MCP shutdown."));
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
