import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SmokeStdoutValidator } from "./mcp-smoke-stdout.mjs";

const requiredNodeVersion = "v26.5.0";
if (process.version !== requiredNodeVersion) {
  throw new Error(
    `MCP bridge builds require Node ${requiredNodeVersion}; found ${process.version}.`,
  );
}

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const outputPath = path.join(
  repositoryRoot,
  "mcp-extension",
  "dist",
  "mcp-bridge.exe",
);
await fs.mkdir(path.dirname(outputPath), { recursive: true });

run(process.execPath, ["esbuild.mjs"], path.join(repositoryRoot, "mcp-server"));
run(
  process.execPath,
  ["--build-sea", "mcp-server/sea-config.json"],
  repositoryRoot,
);

const executable = await fs.readFile(outputPath);
verifyAmd64Pe(executable);
const sha256 = createHash("sha256").update(executable).digest("hex");
await verifyReviewedInventory(sha256);

await smokeTest(outputPath);
console.log(`MCP bridge SEA built and smoke-tested: ${path.relative(repositoryRoot, outputPath)}`);

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `Command failed (${command} ${args.join(" ")}):\n${result.error ?? ""}\n${result.stdout}\n${result.stderr}`,
    );
  }
}

async function smokeTest(executablePath) {
  const pipeName = `\\\\.\\pipe\\unity-debugger-pure-mcp-${randomUUID()}`;
  const token = randomBytes(32).toString("base64url");
  let protocolFailure;
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.unref();
    socket.once("close", () => sockets.delete(socket));
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      try {
        buffered = Buffer.concat([buffered, chunk]);
        while (buffered.byteLength >= 4) {
          const length = buffered.readUInt32LE(0);
          if (length > 1_048_576) {
            throw new Error("Smoke bridge frame exceeds the production limit.");
          }
          if (buffered.byteLength < length + 4) {
            return;
          }
          const message = JSON.parse(buffered.subarray(4, length + 4).toString("utf8"));
          buffered = buffered.subarray(length + 4);
          if (
            message?.type !== "hello" ||
            message.protocolVersion !== 1 ||
            message.token !== token
          ) {
            throw new Error("Smoke bridge received an invalid hello frame.");
          }
          socket.write(frame({ type: "helloAck", protocolVersion: 1 }));
        }
      } catch (error) {
        protocolFailure = error;
        socket.destroy();
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ path: pipeName, readableAll: false, writableAll: false }, resolve);
  });
  server.unref();

  let child;
  let timeout;
  let childClosed = false;
  let stderr = "";
  const stdoutValidator = new SmokeStdoutValidator({ expectedToolCount: 19 });
  try {
    child = spawn(executablePath, ["--pipe", pipeName, "--token", token], {
      cwd: repositoryRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: { SystemRoot: process.env.SystemRoot ?? "C:\\Windows", PATH: "" },
      windowsHide: true,
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      try {
        const responseIds = stdoutValidator.push(chunk);
        if (responseIds.includes(2)) {
          child.stdin.end();
        }
      } catch (error) {
        protocolFailure = error;
        child.kill();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const closed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        childClosed = true;
        if (code !== 0) {
          reject(new Error(`MCP bridge SEA smoke test exited ${code}: ${stderr}`));
        } else {
          resolve();
        }
      });
    });
    const timedOut = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        child.kill();
        reject(new Error("Timed out smoke-testing the MCP bridge SEA."));
      }, 10_000);
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "mcp-sea-smoke", version: "1.0.0" },
      },
    })}\n`);
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

    await Promise.race([closed, timedOut]);
    if (protocolFailure !== undefined) {
      throw protocolFailure;
    }
    const messages = stdoutValidator.finish();
    const initialized = messages.get(1);
    const tools = messages.get(2)?.result?.tools;
    if (initialized?.result === undefined || !Array.isArray(tools) || tools.length !== 19) {
      throw new Error("MCP bridge SEA failed initialize/list-tools smoke validation.");
    }
  } finally {
    clearTimeout(timeout);
    if (child !== undefined) {
      child.stdin.destroy();
      if (!childClosed) {
        child.kill();
        await waitBounded(
          new Promise((resolve) => child.once("close", resolve)),
          2_000,
        );
      }
      child.stdout.destroy();
      child.stderr.destroy();
    }
    for (const socket of sockets) {
      socket.destroy();
    }
    if (server.listening) {
      await waitBounded(
        new Promise((resolve) => server.close(resolve)),
        2_000,
      );
    }
    await waitForImmediate();
  }
}

async function waitBounded(operation, milliseconds) {
  let timeout;
  try {
    await Promise.race([
      operation,
      new Promise((resolve) => {
        timeout = setTimeout(resolve, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function frame(value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const encoded = Buffer.allocUnsafe(payload.byteLength + 4);
  encoded.writeUInt32LE(payload.byteLength, 0);
  payload.copy(encoded, 4);
  return encoded;
}

function verifyAmd64Pe(bytes) {
  if (bytes.byteLength < 0x40 || bytes.readUInt16LE(0) !== 0x5a4d) {
    throw new Error("MCP bridge SEA has no DOS PE header.");
  }
  const peOffset = bytes.readUInt32LE(0x3c);
  if (
    peOffset + 6 > bytes.byteLength ||
    bytes.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0"
  ) {
    throw new Error("MCP bridge SEA has no valid PE signature.");
  }
  if (bytes.readUInt16LE(peOffset + 4) !== 0x8664) {
    throw new Error("MCP bridge SEA is not AMD64.");
  }
}

async function verifyReviewedInventory(sha256) {
  const inventoryPath = path.join(
    repositoryRoot,
    "mcp-extension",
    "runtime-inventory.json",
  );
  let inventory;
  try {
    inventory = JSON.parse(await fs.readFile(inventoryPath, "utf8"));
  } catch {
    throw new Error("MCP bridge runtime inventory is missing or malformed.");
  }
  if (
    Object.keys(inventory).sort().join(",") !== "nodeVersion,sha256" ||
    inventory.nodeVersion !== requiredNodeVersion ||
    inventory.sha256 !== sha256
  ) {
    throw new Error(
      "MCP bridge differs from the reviewed Node version or SHA-256 inventory.",
    );
  }
}
