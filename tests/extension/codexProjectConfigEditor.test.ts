import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CODEX_CONFIG_RELATIVE_PATH,
  CODEX_MANAGED_BEGIN,
  CODEX_MANAGED_END,
  CodexProjectConfigEditor,
} from "../../src/external/config/codexProjectConfigEditor.js";

const temporaryRoots: string[] = [];

const MANUAL_TABLE = `[mcp_servers.unity_debugger_pure]
command = "uvx"
args = ["--from", "unity-debugger-pure-mcp==0.1.0", "unity-debugger-pure-mcp"]
startup_timeout_sec = 60
tool_timeout_sec = 70
enabled = true
required = false`;

const MANAGED_BLOCK = `# BEGIN Unity Debugger Pure MCP
[mcp_servers.unity_debugger_pure]
command = "uvx"
args = [
  "--from",
  "unity-debugger-pure-mcp==0.1.0",
  "unity-debugger-pure-mcp"
]
startup_timeout_sec = 60
tool_timeout_sec = 70
enabled = true
required = false
# END Unity Debugger Pure MCP`;

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    fs.rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "udp-mcp-codex-"));
  temporaryRoots.push(root);
  return root;
}

async function writeConfig(root: string, text: string | Buffer): Promise<string> {
  const configPath = path.join(root, ...CODEX_CONFIG_RELATIVE_PATH.split("/"));
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, text);
  return configPath;
}

describe("Codex project configuration classification", () => {
  it("distinguishes an absent entry from a compatible manual entry", async () => {
    const root = await temporaryRoot();
    const editor = await CodexProjectConfigEditor.create(root);

    await expect(editor.inspect()).resolves.toMatchObject({
      client: "codex",
      state: "absent",
      filePath: path.join(root, ".codex", "config.toml"),
      revision: null,
    });

    await writeConfig(root, `[unrelated]\nvalue = "keep"\n\n${MANUAL_TABLE}\n`);
    await expect(editor.inspect()).resolves.toMatchObject({
      client: "codex",
      state: "compatible-unmanaged",
      detectedLauncherVersion: "0.1.0",
    });
  });

  it("treats a present non-table mcp_servers value as a conflict", async () => {
    const root = await temporaryRoot();
    const editor = await CodexProjectConfigEditor.create(root);

    for (const input of [
      'mcp_servers = "existing"\n',
      'mcp_servers = ["existing"]\n',
    ]) {
      const configPath = await writeConfig(root, input);
      const observed = await editor.inspect();

      expect(observed).toMatchObject({ state: "conflict" });
      await expect(editor.apply("configure", observed)).rejects.toMatchObject({
        code: "CONFIG_CHANGED",
      });
      expect(await fs.readFile(configPath, "utf8")).toBe(input);
    }
  });

  it("recognizes only the exact managed current launcher block", async () => {
    const root = await temporaryRoot();
    const configPath = await writeConfig(root, `${MANAGED_BLOCK}\n`);
    const editor = await CodexProjectConfigEditor.create(root);

    await expect(editor.inspect()).resolves.toMatchObject({
      state: "managed-current",
      detectedLauncherVersion: "0.1.0",
    });

    await fs.writeFile(
      configPath,
      `${MANAGED_BLOCK.replace("==0.1.0", "==0.0.9")}\n`,
      "utf8",
    );
    await expect(editor.inspect()).resolves.toMatchObject({ state: "conflict" });
  });

  it("does not offer adoption for an unrecognized manual launcher pin", async () => {
    const root = await temporaryRoot();
    await writeConfig(root, MANUAL_TABLE.replace("==0.1.0", "==0.0.9"));
    const editor = await CodexProjectConfigEditor.create(root);

    await expect(editor.inspect()).resolves.toMatchObject({ state: "conflict" });
  });

  it("rejects an END marker that leaves target assignments outside ownership", async () => {
    const root = await temporaryRoot();
    await writeConfig(root, `${CODEX_MANAGED_BEGIN}
[mcp_servers.unity_debugger_pure]
command = "uvx"
args = ["--from", "unity-debugger-pure-mcp==0.1.0", "unity-debugger-pure-mcp"]
${CODEX_MANAGED_END}
startup_timeout_sec = 60
tool_timeout_sec = 70
enabled = true
required = false
`);
    const editor = await CodexProjectConfigEditor.create(root);

    await expect(editor.inspect()).resolves.toMatchObject({ state: "conflict" });
  });

  it("recognizes a safely locatable quoted target table", async () => {
    const root = await temporaryRoot();
    await writeConfig(
      root,
      MANUAL_TABLE.replace(
        "[mcp_servers.unity_debugger_pure]",
        '["mcp_servers" . "unity_debugger_pure"]',
      ),
    );
    const editor = await CodexProjectConfigEditor.create(root);

    await expect(editor.inspect()).resolves.toMatchObject({
      state: "compatible-unmanaged",
    });
  });

  it("fails closed for changed, duplicate, malformed, or incomplete entries", async () => {
    const root = await temporaryRoot();
    const editor = await CodexProjectConfigEditor.create(root);
    const cases = [
      MANUAL_TABLE.replace('command = "uvx"', 'command = "other"'),
      `${MANUAL_TABLE}\nenvironment = { TOKEN = "secret" }`,
      `${CODEX_MANAGED_BEGIN}\n${MANUAL_TABLE}\n`,
      `${MANUAL_TABLE}\n\n${MANUAL_TABLE}\n`,
      'mcp_servers.unity_debugger_pure = "other"',
      "[mcp_servers.unity_debugger_pure\ncommand = \"uvx\"",
    ];

    for (const text of cases) {
      await writeConfig(root, text);
      await expect(editor.inspect()).resolves.toMatchObject({ state: "conflict" });
    }
  });

  it("does not treat marker-looking lines inside multiline strings as ownership", async () => {
    const root = await temporaryRoot();
    await writeConfig(root, `note = """
${CODEX_MANAGED_BEGIN}
${CODEX_MANAGED_END}
"""

${MANUAL_TABLE}
`);
    const editor = await CodexProjectConfigEditor.create(root);

    await expect(editor.inspect()).resolves.toMatchObject({
      state: "compatible-unmanaged",
    });
  });
});

describe("Codex project configuration actions", () => {
  it("configures an absent file with the exact managed block", async () => {
    const root = await temporaryRoot();
    const editor = await CodexProjectConfigEditor.create(root);
    const absent = await editor.inspect();

    await editor.apply("configure", absent);

    expect(await fs.readFile(path.join(root, ".codex", "config.toml"), "utf8"))
      .toBe(`${MANAGED_BLOCK}\n`);
    await expect(editor.inspect()).resolves.toMatchObject({ state: "managed-current" });
  });

  it("appends without rewriting an unrelated file that has no final newline", async () => {
    const root = await temporaryRoot();
    const prefix = `title = "keep"`;
    const configPath = await writeConfig(root, prefix);
    const editor = await CodexProjectConfigEditor.create(root);
    const absent = await editor.inspect();

    await editor.apply("configure", absent);

    expect(await fs.readFile(configPath, "utf8"))
      .toBe(`${prefix}\n\n${MANAGED_BLOCK}\n`);
  });

  it("adopts only the compatible target table and preserves surrounding bytes", async () => {
    const root = await temporaryRoot();
    const prefix = `[unrelated]\nvalue = "before"\n\n`;
    const suffix = `[after]\nvalue = "after"\n`;
    const configPath = await writeConfig(
      root,
      `${prefix}${MANUAL_TABLE}\n\n${suffix}`,
    );
    const editor = await CodexProjectConfigEditor.create(root);
    const manual = await editor.inspect();

    await editor.apply("adopt", manual);

    expect(await fs.readFile(configPath, "utf8"))
      .toBe(`${prefix}${MANAGED_BLOCK}\n\n${suffix}`);
  });

  it("removes only the owned block", async () => {
    const root = await temporaryRoot();
    const prefix = `[unrelated]\nvalue = "before"\n\n`;
    const suffix = `[after]\nvalue = "after"\n`;
    const configPath = await writeConfig(
      root,
      `${prefix}${MANAGED_BLOCK}\n\n${suffix}`,
    );
    const editor = await CodexProjectConfigEditor.create(root);
    const managed = await editor.inspect();

    await editor.apply("remove", managed);

    expect(await fs.readFile(configPath, "utf8")).toBe(`${prefix}${suffix}`);
  });

  it("preserves additional blank lines around the owned block", async () => {
    const root = await temporaryRoot();
    const prefix = `[unrelated]\nvalue = "before"\n\n\n\n`;
    const suffix = `[after]\nvalue = "after"\n`;
    const configPath = await writeConfig(
      root,
      `${prefix}${MANAGED_BLOCK}\n\n\n\n${suffix}`,
    );
    const editor = await CodexProjectConfigEditor.create(root);

    await editor.apply("remove", await editor.inspect());

    expect(await fs.readFile(configPath, "utf8"))
      .toBe(`${prefix}\n\n${suffix}`);
  });

  it("preserves a UTF-8 BOM and CRLF convention while configuring", async () => {
    const root = await temporaryRoot();
    const configPath = await writeConfig(
      root,
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(`title = "keep"\r\n`, "utf8"),
      ]),
    );
    const editor = await CodexProjectConfigEditor.create(root);
    const absent = await editor.inspect();

    await editor.apply("configure", absent);

    const bytes = await fs.readFile(configPath);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.subarray(3).toString("utf8")).toBe(
      `title = "keep"\r\n\r\n${MANAGED_BLOCK.replaceAll("\n", "\r\n")}\r\n`,
    );
  });

  it("rejects a wrong action and a stale revision without changing bytes", async () => {
    const root = await temporaryRoot();
    const configPath = await writeConfig(root, `${MANUAL_TABLE}\n`);
    const editor = await CodexProjectConfigEditor.create(root);
    const manual = await editor.inspect();

    await expect(editor.apply("remove", manual)).rejects.toMatchObject({
      code: "CONFIG_CHANGED",
    });
    await fs.writeFile(configPath, `${MANUAL_TABLE}\n# changed\n`, "utf8");
    await expect(editor.apply("adopt", manual)).rejects.toMatchObject({
      code: "CONFIG_CHANGED",
    });
    expect(await fs.readFile(configPath, "utf8"))
      .toBe(`${MANUAL_TABLE}\n# changed\n`);
  });
});
