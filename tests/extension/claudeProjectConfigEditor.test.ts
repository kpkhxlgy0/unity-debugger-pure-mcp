import fsSync from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CLAUDE_CONFIG_RELATIVE_PATH,
  ClaudeProjectConfigEditor,
  type ClaudeOwnershipRecord,
  type ClaudeOwnershipStore,
} from "../../src/external/config/claudeProjectConfigEditor.js";

const temporaryRoots: string[] = [];

const CANONICAL_SERVER = {
  command: "uvx",
  args: [
    "--from",
    "unity-debugger-pure-mcp==0.1.0",
    "unity-debugger-pure-mcp",
  ],
  env: {},
};

const CANONICAL_NEW_FILE = `{
  "mcpServers": {
    "unity_debugger_pure": {
      "command": "uvx",
      "args": [
        "--from",
        "unity-debugger-pure-mcp==0.1.0",
        "unity-debugger-pure-mcp"
      ],
      "env": {}
    }
  }
}
`;

class MemoryOwnershipStore implements ClaudeOwnershipStore {
  public readonly records = new Map<string, ClaudeOwnershipRecord>();
  public failNextUpdate = false;
  public onUpdate: (() => Promise<void>) | undefined;

  public async get(workspaceIdentity: string): Promise<ClaudeOwnershipRecord | undefined> {
    return this.records.get(workspaceIdentity);
  }

  public async update(
    workspaceIdentity: string,
    value: ClaudeOwnershipRecord | undefined,
  ): Promise<void> {
    if (this.onUpdate !== undefined) {
      await this.onUpdate();
    }
    if (this.failNextUpdate) {
      this.failNextUpdate = false;
      throw new Error("ownership unavailable");
    }
    if (value === undefined) {
      this.records.delete(workspaceIdentity);
    } else {
      this.records.set(workspaceIdentity, value);
    }
  }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    fs.rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "udp-mcp-claude-"));
  temporaryRoots.push(root);
  return root;
}

async function writeConfig(root: string, text: string | Buffer): Promise<string> {
  const configPath = path.join(root, CLAUDE_CONFIG_RELATIVE_PATH);
  await fs.writeFile(configPath, text);
  return configPath;
}

async function createEditor(
  root: string,
  ownership = new MemoryOwnershipStore(),
): Promise<{ editor: ClaudeProjectConfigEditor; ownership: MemoryOwnershipStore }> {
  return {
    editor: await ClaudeProjectConfigEditor.create({ workspaceRoot: root, ownership }),
    ownership,
  };
}

describe("Claude project configuration classification", () => {
  it("distinguishes missing entries from a compatible manual server", async () => {
    const root = await temporaryRoot();
    const { editor } = await createEditor(root);

    await expect(editor.inspect()).resolves.toMatchObject({
      client: "claude",
      state: "absent",
      filePath: path.join(root, ".mcp.json"),
      revision: null,
    });

    await writeConfig(root, JSON.stringify({
      mcpServers: { other: { command: "other", args: [] } },
      unrelated: true,
    }));
    await expect(editor.inspect()).resolves.toMatchObject({ state: "absent" });

    await writeConfig(root, JSON.stringify({
      mcpServers: { unity_debugger_pure: CANONICAL_SERVER },
    }));
    await expect(editor.inspect()).resolves.toMatchObject({
      state: "compatible-unmanaged",
      detectedLauncherVersion: "0.1.0",
    });
  });

  it("becomes managed only after explicit adoption records the fingerprint", async () => {
    const root = await temporaryRoot();
    const configPath = await writeConfig(root, JSON.stringify({
      mcpServers: { unity_debugger_pure: CANONICAL_SERVER },
    }));
    const { editor, ownership } = await createEditor(root);
    const manual = await editor.inspect();
    const before = await fs.readFile(configPath);

    await editor.apply("adopt", manual);

    expect(await fs.readFile(configPath)).toEqual(before);
    await expect(editor.inspect()).resolves.toMatchObject({ state: "managed-current" });
    expect(ownership.records.size).toBe(1);
    const [workspaceIdentity, record] = [...ownership.records.entries()][0]!;
    expect(workspaceIdentity).toMatch(/^[a-f0-9]{64}$/);
    expect(record).toMatchObject({
      schemaVersion: 1,
      workspaceIdentity,
      launcherVersion: "0.1.0",
    });
    expect(record.serverFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(record)).not.toContain(root);
  });

  it("fails closed when a stored ownership fingerprint is stale", async () => {
    const root = await temporaryRoot();
    await writeConfig(root, JSON.stringify({
      mcpServers: { unity_debugger_pure: CANONICAL_SERVER },
    }));
    const { editor, ownership } = await createEditor(root);
    await editor.apply("adopt", await editor.inspect());
    const [identity, record] = [...ownership.records.entries()][0]!;
    ownership.records.set(identity, { ...record, serverFingerprint: "0".repeat(64) });

    await expect(editor.inspect()).resolves.toMatchObject({ state: "conflict" });
  });

  it("rejects unrecognized pins and non-canonical server objects", async () => {
    const root = await temporaryRoot();
    const { editor } = await createEditor(root);
    const cases: unknown[] = [
      { ...CANONICAL_SERVER, args: ["--from", "unity-debugger-pure-mcp==0.0.9", "unity-debugger-pure-mcp"] },
      { ...CANONICAL_SERVER, command: "other" },
      { ...CANONICAL_SERVER, extra: true },
      { ...CANONICAL_SERVER, env: { TOKEN: "secret" } },
      "other",
    ];

    for (const server of cases) {
      await writeConfig(root, JSON.stringify({
        mcpServers: { unity_debugger_pure: server },
      }));
      await expect(editor.inspect()).resolves.toMatchObject({ state: "conflict" });
    }
  });

  it("rejects comments, trailing commas, duplicate properties, and invalid roots", async () => {
    const root = await temporaryRoot();
    const { editor } = await createEditor(root);
    const cases = [
      `{"mcpServers": { /* comment */ "unity_debugger_pure": ${JSON.stringify(CANONICAL_SERVER)} }}`,
      `{"mcpServers": {"unity_debugger_pure": ${JSON.stringify(CANONICAL_SERVER)},}}`,
      `{"mcpServers": {"unity_debugger_pure": ${JSON.stringify(CANONICAL_SERVER)}, "unity_debugger_pure": ${JSON.stringify(CANONICAL_SERVER)}}}`,
      `{"mcpServers": []}`,
      `[]`,
      `{`,
    ];

    for (const text of cases) {
      await writeConfig(root, text);
      await expect(editor.inspect()).resolves.toMatchObject({ state: "conflict" });
    }
  });
});

describe("Claude project configuration actions", () => {
  it("configures an absent file with exact strict JSON", async () => {
    const root = await temporaryRoot();
    const { editor } = await createEditor(root);

    await editor.apply("configure", await editor.inspect());

    expect(await fs.readFile(path.join(root, ".mcp.json"), "utf8"))
      .toBe(CANONICAL_NEW_FILE);
    await expect(editor.inspect()).resolves.toMatchObject({ state: "managed-current" });
  });

  it("preserves unrelated properties, servers, and four-space formatting", async () => {
    const root = await temporaryRoot();
    const input = `{
    "before": { "keep": true },
    "mcpServers": {
        "other": { "command": "other", "args": [] }
    },
    "after": 7
}
`;
    const configPath = await writeConfig(root, input);
    const { editor } = await createEditor(root);

    await editor.apply("configure", await editor.inspect());

    const configured = await fs.readFile(configPath, "utf8");
    expect(configured).toContain('    "before": { "keep": true },');
    expect(configured).toContain('        "other": { "command": "other", "args": [] },');
    expect(configured).toContain('    "after": 7');
    expect(JSON.parse(configured)).toEqual({
      before: { keep: true },
      mcpServers: {
        other: { command: "other", args: [] },
        unity_debugger_pure: CANONICAL_SERVER,
      },
      after: 7,
    });
  });

  it("preserves UTF-8 BOM, CRLF, indentation, and final newline", async () => {
    const root = await temporaryRoot();
    const configPath = await writeConfig(root, Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(`{\r\n  "mcpServers": {}\r\n}\r\n`, "utf8"),
    ]));
    const { editor } = await createEditor(root);

    await editor.apply("configure", await editor.inspect());

    const bytes = await fs.readFile(configPath);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = bytes.subarray(3).toString("utf8");
    expect(text).not.toMatch(/(?<!\r)\n/u);
    expect(text).toMatch(/\r\n  "mcpServers"/u);
    expect(text.endsWith("\r\n")).toBe(true);
  });

  it("removes only the managed server and keeps other servers", async () => {
    const root = await temporaryRoot();
    const configPath = await writeConfig(root, JSON.stringify({
      mcpServers: {
        other: { command: "other", args: [] },
        unity_debugger_pure: CANONICAL_SERVER,
      },
      keep: true,
    }, null, 2) + "\n");
    const { editor } = await createEditor(root);
    await editor.apply("adopt", await editor.inspect());

    await editor.apply("remove", await editor.inspect());

    expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual({
      mcpServers: { other: { command: "other", args: [] } },
      keep: true,
    });
    await expect(editor.inspect()).resolves.toMatchObject({ state: "absent" });
  });

  it("rolls the file back when publishing ownership fails", async () => {
    const root = await temporaryRoot();
    const { editor, ownership } = await createEditor(root);
    ownership.failNextUpdate = true;

    await expect(editor.apply("configure", await editor.inspect()))
      .rejects.toMatchObject({ code: "CONFIG_WRITE_FAILED" });

    await expect(fs.stat(path.join(root, ".mcp.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(ownership.records.size).toBe(0);
  });

  it("does not roll back over a concurrent edit after publishing the file", async () => {
    const root = await temporaryRoot();
    const configPath = path.join(root, ".mcp.json");
    const concurrent = '{"concurrent":true}\n';
    const { editor, ownership } = await createEditor(root);
    ownership.failNextUpdate = true;
    const originalOpen = fs.open.bind(fs);
    let injected = false;
    const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (path.resolve(String(args[0])) !== path.resolve(configPath) || injected) {
        return handle;
      }
      return new Proxy(handle, {
        get(target, property) {
          if (property === "readFile") {
            return async (...readArgs: Parameters<typeof target.readFile>) => {
              injected = true;
              await fs.writeFile(configPath, concurrent, "utf8");
              return target.readFile(...readArgs);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });

    try {
      await expect(editor.apply("configure", await editor.inspect()))
        .rejects.toMatchObject({ code: "CONFIG_WRITE_FAILED" });
    } finally {
      open.mockRestore();
    }

    expect(injected).toBe(true);
    expect(await fs.readFile(configPath, "utf8")).toBe(concurrent);
    expect(ownership.records.size).toBe(0);
  });

  it("publishes ownership only after the new file is readable", async () => {
    const root = await temporaryRoot();
    const configPath = path.join(root, ".mcp.json");
    const { editor, ownership } = await createEditor(root);
    ownership.onUpdate = async () => {
      expect(JSON.parse(await fs.readFile(configPath, "utf8")))
        .toEqual({ mcpServers: { unity_debugger_pure: CANONICAL_SERVER } });
    };

    await editor.apply("configure", await editor.inspect());
  });

  it("does not publish ownership when the file replacement fails", async () => {
    const root = await temporaryRoot();
    const { editor, ownership } = await createEditor(root);
    const absent = await editor.inspect();
    const configPath = path.join(root, ".mcp.json");
    const watcher = fsSync.watch(root, (_event, name) => {
      if (name?.startsWith(".mcp.json.")) {
        try {
          fsSync.mkdirSync(configPath);
        } catch {
          // The target may already exist after the first event.
        }
      }
    });

    try {
      await expect(editor.apply("configure", absent)).rejects.toMatchObject({
        code: "CONFIG_NOT_ALLOWED",
      });
    } finally {
      watcher.close();
    }
    expect(ownership.records.size).toBe(0);
  });

  it("rejects stale and wrong actions without changing the file or ownership", async () => {
    const root = await temporaryRoot();
    const configPath = await writeConfig(root, JSON.stringify({
      mcpServers: { unity_debugger_pure: CANONICAL_SERVER },
    }));
    const { editor, ownership } = await createEditor(root);
    const manual = await editor.inspect();

    await expect(editor.apply("remove", manual)).rejects.toMatchObject({
      code: "CONFIG_CHANGED",
    });
    await fs.writeFile(configPath, JSON.stringify({ keep: true }), "utf8");
    await expect(editor.apply("adopt", manual)).rejects.toMatchObject({
      code: "CONFIG_CHANGED",
    });
    expect(ownership.records.size).toBe(0);
    expect(await fs.readFile(configPath, "utf8")).toBe('{"keep":true}');
  });
});
