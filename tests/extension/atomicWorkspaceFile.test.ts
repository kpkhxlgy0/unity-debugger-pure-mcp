import { createHash } from "node:crypto";
import fs from "node:fs";
import { promises as fsPromises } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EXTERNAL_LAUNCHER_ARGS,
  EXTERNAL_LAUNCHER_VERSION,
  EXTERNAL_MCP_SERVER_NAME,
  RECOGNIZED_EXTERNAL_LAUNCHER_VERSIONS,
} from "../../src/external/config/externalLauncherDescriptor.js";
import {
  AtomicWorkspaceFile,
  MAX_EXTERNAL_CONFIG_BYTES,
} from "../../src/external/config/atomicWorkspaceFile.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    fsPromises.rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "udp-mcp-config-"));
  temporaryRoots.push(root);
  return root;
}

describe("external launcher descriptor", () => {
  it("produces the reviewed project-scoped launcher invocation", () => {
    expect(EXTERNAL_MCP_SERVER_NAME).toBe("unity_debugger_pure");
    expect(EXTERNAL_LAUNCHER_VERSION).toBe("0.1.0");
    expect(RECOGNIZED_EXTERNAL_LAUNCHER_VERSIONS).toEqual(["0.1.0"]);
    expect(EXTERNAL_LAUNCHER_ARGS).toEqual([
      "--from",
      "unity-debugger-pure-mcp==0.1.0",
      "unity-debugger-pure-mcp",
    ]);
    expect(JSON.stringify(EXTERNAL_LAUNCHER_ARGS)).not.toMatch(
      /Admin|Users|pipe|token|AppData/i,
    );
  });
});

describe("atomic workspace file", () => {
  it("creates the fixed project file and rejects a stale revision", async () => {
    const root = await temporaryRoot();
    const file = await AtomicWorkspaceFile.create({
      workspaceRoot: root,
      relativePath: ".codex/config.toml",
    });

    const absent = await file.read();
    expect(absent).toMatchObject({
      exists: false,
      revision: null,
      bom: false,
      newline: "\n",
    });
    await file.replace(absent, Buffer.from("first\r\n", "utf8"));

    const first = await file.read();
    expect(first.bytes.toString("utf8")).toBe("first\r\n");
    expect(first.newline).toBe("\r\n");
    expect(first.revision).toBe(
      createHash("sha256").update(Buffer.from("first\r\n")).digest("hex"),
    );
    await fsPromises.writeFile(file.filePath, "other\n", "utf8");

    await expect(file.replace(first, Buffer.from("stale\n", "utf8")))
      .rejects.toMatchObject({
        code: "CONFIG_CHANGED",
        message: "The project configuration changed. Run the command again.",
      });
    expect(await fsPromises.readFile(file.filePath, "utf8")).toBe("other\n");
  });

  it("accepts exactly 256 KiB and rejects one additional byte", async () => {
    const root = await temporaryRoot();
    const configPath = path.join(root, ".mcp.json");
    const file = await AtomicWorkspaceFile.create({
      workspaceRoot: root,
      relativePath: ".mcp.json",
    });
    const exact = Buffer.alloc(MAX_EXTERNAL_CONFIG_BYTES, 0x20);
    await fsPromises.writeFile(configPath, exact);

    const snapshot = await file.read();
    expect(snapshot.bytes).toHaveLength(256 * 1024);
    await fsPromises.writeFile(configPath, Buffer.alloc(MAX_EXTERNAL_CONFIG_BYTES + 1, 0x20));

    await expect(file.read()).rejects.toMatchObject({
      code: "CONFIG_TOO_LARGE",
      message: "The project configuration file is too large.",
    });
    await expect(file.replace(snapshot, Buffer.alloc(MAX_EXTERNAL_CONFIG_BYTES + 1)))
      .rejects.toMatchObject({ code: "CONFIG_TOO_LARGE" });
  });

  it("reports the exact UTF-8 BOM and first newline convention", async () => {
    const root = await temporaryRoot();
    const configPath = path.join(root, ".mcp.json");
    await fsPromises.writeFile(
      configPath,
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("{\r\n  \"mcpServers\": {}\r\n}\r\n", "utf8"),
      ]),
    );
    const file = await AtomicWorkspaceFile.create({
      workspaceRoot: root,
      relativePath: ".mcp.json",
    });

    const snapshot = await file.read();

    expect(snapshot.bom).toBe(true);
    expect(snapshot.newline).toBe("\r\n");
  });

  it("exposes a stable opaque workspace identity instead of the root", async () => {
    const root = await temporaryRoot();
    const file = await AtomicWorkspaceFile.create({
      workspaceRoot: root,
      relativePath: ".mcp.json",
    });

    expect(file.workspaceIdentity).toMatch(/^[a-f0-9]{64}$/);
    expect(file.workspaceIdentity).not.toContain(root.toLowerCase());
    const same = await AtomicWorkspaceFile.create({
      workspaceRoot: root,
      relativePath: ".codex/config.toml",
    });
    expect(same.workspaceIdentity).toBe(file.workspaceIdentity);
  });

  it("rejects arbitrary, absolute, and traversal relative paths at runtime", async () => {
    const root = await temporaryRoot();
    const invalid = ["other.json", "../escape", "C:\\escape.json"];

    for (const relativePath of invalid) {
      await expect(AtomicWorkspaceFile.create({
        workspaceRoot: root,
        relativePath: relativePath as ".mcp.json",
      })).rejects.toMatchObject({
        code: "CONFIG_NOT_ALLOWED",
        message: "The project configuration file is not allowed.",
      });
    }
  });

  it("rejects a file symlink that escapes the workspace", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const outsideFile = path.join(outside, "outside.json");
    await fsPromises.writeFile(outsideFile, "{}", "utf8");
    await fsPromises.symlink(outsideFile, path.join(root, ".mcp.json"), "file");
    const file = await AtomicWorkspaceFile.create({
      workspaceRoot: root,
      relativePath: ".mcp.json",
    });

    await expect(file.read()).rejects.toMatchObject({ code: "CONFIG_NOT_ALLOWED" });
  });

  it("rejects a parent junction that escapes the workspace", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await fsPromises.mkdir(path.join(outside, "codex"));
    await fsPromises.writeFile(path.join(outside, "codex", "config.toml"), "x=1", "utf8");
    await fsPromises.symlink(
      path.join(outside, "codex"),
      path.join(root, ".codex"),
      "junction",
    );
    const file = await AtomicWorkspaceFile.create({
      workspaceRoot: root,
      relativePath: ".codex/config.toml",
    });

    await expect(file.read()).rejects.toMatchObject({ code: "CONFIG_NOT_ALLOWED" });
  });

  it("fails closed when the parent is replaced by a junction during replace", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const parent = path.join(root, ".codex");
    const movedParent = path.join(root, ".codex-original");
    const outsideConfig = path.join(outside, "config.toml");
    const original = 'value = "original"\n';
    const replacement = Buffer.from('value = "managed"\n', "utf8");
    await fsPromises.mkdir(parent);
    await fsPromises.writeFile(path.join(parent, "config.toml"), original, "utf8");
    await fsPromises.writeFile(outsideConfig, original, "utf8");
    const file = await AtomicWorkspaceFile.create({
      workspaceRoot: root,
      relativePath: ".codex/config.toml",
    });
    const expected = await file.read();
    const originalOpen = fsPromises.open.bind(fsPromises);
    let swapped = false;
    let outsideWriteObserved = false;
    const open = vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      const openedPath = path.resolve(String(args[0]));
      if (!swapped && openedPath.startsWith(`${path.resolve(parent)}${path.sep}`) && openedPath.endsWith(".tmp")) {
        swapped = true;
        await fsPromises.rename(parent, movedParent);
        await fsPromises.symlink(outside, parent, "junction");
      }
      const handle = await originalOpen(...args);
      if (!openedPath.endsWith(".tmp")) {
        return handle;
      }
      return new Proxy(handle, {
        get(target, property) {
          if (property === "writeFile") {
            return async (...writeArgs: Parameters<typeof target.writeFile>) => {
              await target.writeFile(...writeArgs);
              const resolved = await fsPromises.realpath(openedPath);
              outsideWriteObserved = path.dirname(resolved) === path.resolve(outside);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });

    try {
      await expect(file.replace(expected, replacement)).rejects.toMatchObject({
        code: "CONFIG_NOT_ALLOWED",
      });
    } finally {
      open.mockRestore();
    }

    expect(swapped).toBe(true);
    expect(outsideWriteObserved).toBe(false);
    expect(await fsPromises.readFile(outsideConfig, "utf8")).toBe(original);
    expect(await fsPromises.readFile(path.join(movedParent, "config.toml"), "utf8"))
      .toBe(original);
    expect((await fsPromises.readdir(outside)).filter((entry) => entry.endsWith(".tmp")))
      .toEqual([]);
  });

  it("rejects a stale absent snapshot when another process creates the file", async () => {
    const root = await temporaryRoot();
    const file = await AtomicWorkspaceFile.create({
      workspaceRoot: root,
      relativePath: ".mcp.json",
    });
    const absent = await file.read();
    await fsPromises.writeFile(file.filePath, "{}", "utf8");

    await expect(file.replace(absent, Buffer.from("{\"new\":true}", "utf8")))
      .rejects.toMatchObject({ code: "CONFIG_CHANGED" });
    expect(await fsPromises.readFile(file.filePath, "utf8")).toBe("{}");
  });

  it("rejects a concurrent create after the temporary replacement is durable", async () => {
    const root = await temporaryRoot();
    const file = await AtomicWorkspaceFile.create({
      workspaceRoot: root,
      relativePath: ".mcp.json",
    });
    const absent = await file.read();
    const originalOpen = fsPromises.open.bind(fsPromises);
    const open = vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (!String(args[0]).endsWith(".tmp")) {
        return handle;
      }
      return new Proxy(handle, {
        get(target, property) {
          if (property === "close") {
            return async () => {
              await target.close();
              await fsPromises.writeFile(file.filePath, "{\"concurrent\":true}", "utf8");
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });

    try {
      await expect(file.replace(absent, Buffer.from("{\"managed\":true}", "utf8")))
        .rejects.toMatchObject({ code: "CONFIG_CHANGED" });
    } finally {
      open.mockRestore();
    }

    expect(await fsPromises.readFile(file.filePath, "utf8"))
      .toBe("{\"concurrent\":true}");
    expect((await fsPromises.readdir(root)).filter((entry) => entry.endsWith(".tmp")))
      .toEqual([]);
  });

  it("does not overwrite a file created after the final absent revision check", async () => {
    const root = await temporaryRoot();
    const file = await AtomicWorkspaceFile.create({
      workspaceRoot: root,
      relativePath: ".mcp.json",
    });
    const absent = await file.read();
    const originalLink = fsPromises.link.bind(fsPromises);
    const link = vi.spyOn(fsPromises, "link").mockImplementationOnce(async (...args) => {
      await fsPromises.writeFile(file.filePath, "{\"concurrent\":true}", "utf8");
      return originalLink(...args);
    });

    try {
      await expect(file.replace(absent, Buffer.from("{\"managed\":true}", "utf8")))
        .rejects.toMatchObject({ code: "CONFIG_CHANGED" });
    } finally {
      link.mockRestore();
    }

    expect(await fsPromises.readFile(file.filePath, "utf8"))
      .toBe("{\"concurrent\":true}");
    expect((await fsPromises.readdir(root)).filter((entry) => entry.endsWith(".tmp")))
      .toEqual([]);
  });

  it("retries temporary hard-link cleanup in finally", async () => {
    const root = await temporaryRoot();
    const file = await AtomicWorkspaceFile.create({
      workspaceRoot: root,
      relativePath: ".mcp.json",
    });
    const absent = await file.read();
    const unlink = vi.spyOn(fsPromises, "unlink").mockImplementationOnce(async () => {
      const error = new Error("busy") as NodeJS.ErrnoException;
      error.code = "EBUSY";
      throw error;
    });

    try {
      await file.replace(absent, Buffer.from("{\"managed\":true}", "utf8"));
    } finally {
      unlink.mockRestore();
    }

    expect(await fsPromises.readFile(file.filePath, "utf8"))
      .toBe("{\"managed\":true}");
    expect((await fsPromises.readdir(root)).filter((entry) => entry.endsWith(".tmp")))
      .toEqual([]);
  });

  it("removes only the file represented by the expected revision", async () => {
    const root = await temporaryRoot();
    const file = await AtomicWorkspaceFile.create({
      workspaceRoot: root,
      relativePath: ".mcp.json",
    });
    await fsPromises.writeFile(file.filePath, "{\"first\":true}", "utf8");
    const first = await file.read();

    await file.remove(first);

    await expect(file.read()).resolves.toMatchObject({ exists: false, revision: null });
    await fsPromises.writeFile(file.filePath, "{\"second\":true}", "utf8");
    await expect(file.remove(first)).rejects.toMatchObject({ code: "CONFIG_CHANGED" });
    expect(await fsPromises.readFile(file.filePath, "utf8"))
      .toBe("{\"second\":true}");
  });

  it("rejects a concurrent edit after the initial removal revision check", async () => {
    const root = await temporaryRoot();
    const file = await AtomicWorkspaceFile.create({
      workspaceRoot: root,
      relativePath: ".mcp.json",
    });
    await fsPromises.writeFile(file.filePath, "{\"first\":true}", "utf8");
    const first = await file.read();
    const originalLstat = fsPromises.lstat.bind(fsPromises);
    let targetChecks = 0;
    const lstat = vi.spyOn(fsPromises, "lstat").mockImplementation(async (...args) => {
      const status = await originalLstat(...args);
      if (path.resolve(String(args[0])) === path.resolve(file.filePath)) {
        targetChecks += 1;
        if (targetChecks === 2) {
          await fsPromises.writeFile(file.filePath, "{\"concurrent\":true}", "utf8");
        }
      }
      return status;
    });

    try {
      await expect(file.remove(first)).rejects.toMatchObject({ code: "CONFIG_CHANGED" });
    } finally {
      lstat.mockRestore();
    }

    expect(await fsPromises.readFile(file.filePath, "utf8"))
      .toBe("{\"concurrent\":true}");
  });

  it("cleans its same-directory temporary file when the target becomes invalid", async () => {
    const root = await temporaryRoot();
    const file = await AtomicWorkspaceFile.create({
      workspaceRoot: root,
      relativePath: ".mcp.json",
    });
    const absent = await file.read();
    const watcher = fs.watch(root, (_event, name) => {
      if (name?.startsWith(".mcp.json.")) {
        try {
          fs.mkdirSync(file.filePath);
        } catch {
          // The target may already have been created by an earlier event.
        }
      }
    });

    try {
      await expect(file.replace(absent, Buffer.alloc(MAX_EXTERNAL_CONFIG_BYTES, 0x20)))
        .rejects.toMatchObject({ code: "CONFIG_NOT_ALLOWED" });
    } finally {
      watcher.close();
    }

    const entries = await fsPromises.readdir(root);
    expect(entries.filter((entry) => entry.startsWith(".mcp.json."))).toEqual([]);
  });

  it("keeps public errors free of paths and configuration bytes", async () => {
    const root = await temporaryRoot();
    const secret = "PRIVATE_CONFIGURATION_VALUE";
    await fsPromises.writeFile(path.join(root, ".mcp.json"), Buffer.alloc(
      MAX_EXTERNAL_CONFIG_BYTES + 1,
      secret.charCodeAt(0),
    ));
    const file = await AtomicWorkspaceFile.create({
      workspaceRoot: root,
      relativePath: ".mcp.json",
    });

    const error = await file.read().catch((value: unknown) => value);

    expect(error).toMatchObject({ code: "CONFIG_TOO_LARGE" });
    expect(String(error)).not.toContain(root);
    expect(String(error)).not.toContain(secret);
  });
});
