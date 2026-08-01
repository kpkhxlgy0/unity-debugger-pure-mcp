import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const vscodeHarness = vi.hoisted(() => {
  const state = {
    trusted: true,
    folders: [] as Array<{
      readonly name: string;
      readonly uri: { readonly scheme: string; readonly fsPath: string };
    }>,
    commands: new Map<string, () => Promise<void>>(),
    quickPickResult: undefined as unknown,
    messageResult: undefined as unknown,
    quickPickCalls: [] as unknown[],
    informationCalls: [] as unknown[],
    warningCalls: [] as unknown[],
    opened: [] as string[],
  };
  return { state };
});

vi.mock("vscode", () => ({
  Uri: {
    file: (fsPath: string) => ({ scheme: "file", fsPath }),
  },
  workspace: {
    get isTrusted() { return vscodeHarness.state.trusted; },
    get workspaceFolders() { return vscodeHarness.state.folders; },
    openTextDocument: vi.fn(async (uri: { readonly fsPath: string }) => {
      vscodeHarness.state.opened.push(uri.fsPath);
      return { uri };
    }),
  },
  window: {
    showQuickPick: vi.fn(async (...args: unknown[]) => {
      vscodeHarness.state.quickPickCalls.push(args);
      return vscodeHarness.state.quickPickResult;
    }),
    showInformationMessage: vi.fn(async (...args: unknown[]) => {
      vscodeHarness.state.informationCalls.push(args);
      return vscodeHarness.state.messageResult;
    }),
    showWarningMessage: vi.fn(async (...args: unknown[]) => {
      vscodeHarness.state.warningCalls.push(args);
      return vscodeHarness.state.messageResult;
    }),
    showTextDocument: vi.fn(async () => undefined),
  },
  commands: {
    registerCommand: vi.fn((id: string, handler: () => Promise<void>) => {
      vscodeHarness.state.commands.set(id, handler);
      return {
        dispose: vi.fn(() => vscodeHarness.state.commands.delete(id)),
      };
    }),
  },
}));

import type * as vscode from "vscode";

import type {
  ExternalClientKind,
  ExternalConfigAction,
  ExternalConfigInspection,
  ProjectConfigEditor,
} from "../../src/external/config/externalLauncherDescriptor.js";
import {
  CONFIGURE_CLAUDE_COMMAND,
  CONFIGURE_CODEX_COMMAND,
  createVscodeExternalClientCommands,
  registerExternalClientCommands,
  type ExternalClientCommandsBoundary,
  type ExternalWorkspaceFolder,
} from "../../src/external/config/externalClientCommands.js";

const temporaryRoots: string[] = [];

beforeEach(() => {
  vscodeHarness.state.trusted = true;
  vscodeHarness.state.folders = [];
  vscodeHarness.state.commands.clear();
  vscodeHarness.state.quickPickResult = undefined;
  vscodeHarness.state.messageResult = undefined;
  vscodeHarness.state.quickPickCalls = [];
  vscodeHarness.state.informationCalls = [];
  vscodeHarness.state.warningCalls = [];
  vscodeHarness.state.opened = [];
});

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    fs.rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "udp-mcp-command-"));
  temporaryRoots.push(root);
  return root;
}

class StateEditor implements ProjectConfigEditor {
  public readonly applications: Array<{
    readonly action: ExternalConfigAction;
    readonly expected: ExternalConfigInspection;
  }> = [];

  public constructor(public inspection: ExternalConfigInspection) {}

  public async inspect(): Promise<ExternalConfigInspection> {
    return this.inspection;
  }

  public async apply(
    action: ExternalConfigAction,
    expected: ExternalConfigInspection,
  ): Promise<ExternalConfigInspection> {
    this.applications.push({ action, expected });
    this.inspection = {
      ...expected,
      state: action === "remove" ? "absent" : "managed-current",
      revision: "after",
    };
    return this.inspection;
  }
}

function inspection(
  client: ExternalClientKind,
  state: ExternalConfigInspection["state"],
  root: string,
): ExternalConfigInspection {
  return {
    client,
    state,
    filePath: path.join(root, client === "codex" ? ".codex/config.toml" : ".mcp.json"),
    revision: "before",
    ...(state === "managed-current" || state === "managed-outdated" || state === "compatible-unmanaged"
      ? { detectedLauncherVersion: "0.1.0" }
      : {}),
  };
}

function controllerHarness(options: {
  readonly root: string;
  readonly state?: ExternalConfigInspection["state"];
  readonly client?: ExternalClientKind;
}): {
  readonly boundary: ExternalClientCommandsBoundary;
  readonly editor: StateEditor;
  readonly commands: Map<string, () => Promise<void>>;
  readonly effects: {
    errors: string[];
    successes: Array<{ client: ExternalClientKind; filePath: string }>;
    opened: string[];
    picked: ExternalWorkspaceFolder[][];
    actions: Array<readonly (ExternalConfigAction | "open")[]>;
    roots: string[];
    disposals: string[];
  };
  setTrusted(value: boolean): void;
  setFolders(value: readonly ExternalWorkspaceFolder[]): void;
  setAction(value: ExternalConfigAction | "open" | undefined): void;
  setPick(value: ExternalWorkspaceFolder | undefined): void;
  beforeAction(callback: (() => void) | undefined): void;
} {
  let trusted = true;
  let folders: readonly ExternalWorkspaceFolder[] = [{
    name: "Project",
    scheme: "file",
    fsPath: options.root,
  }];
  let action: ExternalConfigAction | "open" | undefined = "configure";
  let pick: ExternalWorkspaceFolder | undefined;
  let actionCallback: (() => void) | undefined;
  const client = options.client ?? "codex";
  const editor = new StateEditor(inspection(client, options.state ?? "absent", options.root));
  const commands = new Map<string, () => Promise<void>>();
  const effects = {
    errors: [] as string[],
    successes: [] as Array<{ client: ExternalClientKind; filePath: string }>,
    opened: [] as string[],
    picked: [] as ExternalWorkspaceFolder[][],
    actions: [] as Array<readonly (ExternalConfigAction | "open")[]>,
    roots: [] as string[],
    disposals: [] as string[],
  };
  const boundary: ExternalClientCommandsBoundary = {
    isWorkspaceTrusted: () => trusted,
    workspaceFolders: () => folders,
    async pickWorkspace(candidates) {
      effects.picked.push([...candidates]);
      return pick;
    },
    async createEditor(_client, root) {
      effects.roots.push(root);
      return editor;
    },
    async chooseAction({ actions }) {
      effects.actions.push(actions);
      actionCallback?.();
      return action;
    },
    async showSuccess(successClient, filePath) {
      effects.successes.push({ client: successClient, filePath });
    },
    async showError(message) {
      effects.errors.push(message);
    },
    async openConfiguration(filePath) {
      effects.opened.push(filePath);
    },
    registerCommand(id, handler) {
      commands.set(id, handler);
      return {
        dispose() {
          effects.disposals.push(id);
          commands.delete(id);
        },
      };
    },
  };
  return {
    boundary,
    editor,
    commands,
    effects,
    setTrusted(value) { trusted = value; },
    setFolders(value) { folders = value; },
    setAction(value) { action = value; },
    setPick(value) { pick = value; },
    beforeAction(callback) { actionCallback = callback; },
  };
}

describe("external client command controller", () => {
  it("registers both commands without inspecting or changing a project", async () => {
    const root = await temporaryRoot();
    const harness = controllerHarness({ root });

    const registration = registerExternalClientCommands(harness.boundary);

    expect([...harness.commands.keys()]).toEqual([
      CONFIGURE_CODEX_COMMAND,
      CONFIGURE_CLAUDE_COMMAND,
    ]);
    expect(harness.effects.roots).toEqual([]);
    expect(harness.editor.applications).toEqual([]);
    registration.dispose();
    registration.dispose();
    expect(harness.effects.disposals).toEqual([
      CONFIGURE_CLAUDE_COMMAND,
      CONFIGURE_CODEX_COMMAND,
    ]);
  });

  it("refuses untrusted, missing, and remote-only workspaces before creating an editor", async () => {
    const root = await temporaryRoot();
    const cases: Array<(harness: ReturnType<typeof controllerHarness>) => void> = [
      (harness) => harness.setTrusted(false),
      (harness) => harness.setFolders([]),
      (harness) => harness.setFolders([{
        name: "Remote",
        scheme: "vscode-remote",
        fsPath: root,
      }]),
    ];

    for (const setup of cases) {
      const harness = controllerHarness({ root });
      setup(harness);
      registerExternalClientCommands(harness.boundary);
      await harness.commands.get(CONFIGURE_CODEX_COMMAND)!();
      expect(harness.effects.roots).toEqual([]);
      expect(harness.effects.errors).toEqual([
        "Open a trusted local workspace folder to configure this client.",
      ]);
    }
  });

  it("uses a single local root directly and applies the exact inspected revision", async () => {
    const root = await temporaryRoot();
    const harness = controllerHarness({ root });
    registerExternalClientCommands(harness.boundary);

    await harness.commands.get(CONFIGURE_CODEX_COMMAND)!();

    expect(harness.effects.picked).toEqual([]);
    expect(harness.effects.roots).toEqual([root]);
    expect(harness.editor.applications).toEqual([{
      action: "configure",
      expected: inspection("codex", "absent", root),
    }]);
    expect(harness.effects.successes).toEqual([{
      client: "codex",
      filePath: path.join(root, ".codex/config.toml"),
    }]);
  });

  it("requires an explicit selection for a multi-root workspace", async () => {
    const first = await temporaryRoot();
    const second = await temporaryRoot();
    const harness = controllerHarness({ root: second });
    const candidates = [
      { name: "First", scheme: "file", fsPath: first },
      { name: "Second", scheme: "file", fsPath: second },
    ] as const;
    harness.setFolders(candidates);
    harness.setPick(candidates[1]);
    registerExternalClientCommands(harness.boundary);

    await harness.commands.get(CONFIGURE_CODEX_COMMAND)!();

    expect(harness.effects.picked).toEqual([[...candidates]]);
    expect(harness.effects.roots).toEqual([second]);
  });

  it("does nothing when workspace or action selection is cancelled", async () => {
    const first = await temporaryRoot();
    const second = await temporaryRoot();
    const multi = controllerHarness({ root: second });
    multi.setFolders([
      { name: "First", scheme: "file", fsPath: first },
      { name: "Second", scheme: "file", fsPath: second },
    ]);
    registerExternalClientCommands(multi.boundary);
    await multi.commands.get(CONFIGURE_CODEX_COMMAND)!();
    expect(multi.effects.roots).toEqual([]);

    const action = controllerHarness({ root: first });
    action.setAction(undefined);
    registerExternalClientCommands(action.boundary);
    await action.commands.get(CONFIGURE_CODEX_COMMAND)!();
    expect(action.editor.applications).toEqual([]);
    expect(action.effects.errors).toEqual([]);
  });

  it("maps every classified state to only its approved actions", async () => {
    const root = await temporaryRoot();
    const cases = [
      ["absent", ["configure"]],
      ["managed-current", ["remove", "open"]],
      ["managed-outdated", ["update", "remove", "open"]],
      ["compatible-unmanaged", ["adopt", "open"]],
      ["conflict", ["open"]],
    ] as const;

    for (const [state, actions] of cases) {
      const harness = controllerHarness({ root, state });
      harness.setAction(undefined);
      registerExternalClientCommands(harness.boundary);
      await harness.commands.get(CONFIGURE_CODEX_COMMAND)!();
      expect(harness.effects.actions).toEqual([actions]);
      expect(harness.editor.applications).toEqual([]);
      expect(harness.effects.opened).toEqual([]);
    }
  });

  it("rejects an action that was not offered for the inspected state", async () => {
    const root = await temporaryRoot();
    const harness = controllerHarness({ root, state: "conflict" });
    harness.setAction("remove");
    registerExternalClientCommands(harness.boundary);

    await harness.commands.get(CONFIGURE_CODEX_COMMAND)!();

    expect(harness.editor.applications).toEqual([]);
    expect(harness.effects.errors).toEqual([
      "The project configuration could not be changed safely.",
    ]);
  });

  it("rechecks trust and selected-root membership before mutation", async () => {
    const root = await temporaryRoot();
    const trust = controllerHarness({ root });
    trust.beforeAction(() => trust.setTrusted(false));
    registerExternalClientCommands(trust.boundary);
    await trust.commands.get(CONFIGURE_CODEX_COMMAND)!();
    expect(trust.editor.applications).toEqual([]);

    const rootChange = controllerHarness({ root });
    rootChange.beforeAction(() => rootChange.setFolders([]));
    registerExternalClientCommands(rootChange.boundary);
    await rootChange.commands.get(CONFIGURE_CODEX_COMMAND)!();
    expect(rootChange.editor.applications).toEqual([]);
    expect([...trust.effects.errors, ...rootChange.effects.errors]).toEqual([
      "The selected workspace is no longer available or trusted.",
      "The selected workspace is no longer available or trusted.",
    ]);
  });

  it("replaces thrown private details with a fixed public error", async () => {
    const root = await temporaryRoot();
    const harness = controllerHarness({ root });
    harness.editor.inspect = async () => {
      throw new Error(`token=secret path=${root} PRIVATE_CONFIGURATION`);
    };
    registerExternalClientCommands(harness.boundary);

    await harness.commands.get(CONFIGURE_CODEX_COMMAND)!();

    expect(harness.effects.errors).toEqual([
      "The project configuration could not be changed safely.",
    ]);
    expect(harness.effects.errors.join("\n")).not.toMatch(/secret|PRIVATE|udp-mcp-command/i);
  });
});

describe("VS Code external client command adapter", () => {
  function context(): vscode.ExtensionContext {
    const values = new Map<string, unknown>();
    return {
      workspaceState: {
        get: <T>(key: string) => values.get(key) as T | undefined,
        update: async (key: string, value: unknown) => {
          if (value === undefined) {
            values.delete(key);
          } else {
            values.set(key, value);
          }
        },
        keys: () => [...values.keys()],
      },
    } as unknown as vscode.ExtensionContext;
  }

  it("registers the two canonical command IDs and configures real project files", async () => {
    const root = await temporaryRoot();
    vscodeHarness.state.folders = [{
      name: "Project",
      uri: { scheme: "file", fsPath: root },
    }];
    const registration = createVscodeExternalClientCommands(context());

    expect([...vscodeHarness.state.commands.keys()]).toEqual([
      CONFIGURE_CODEX_COMMAND,
      CONFIGURE_CLAUDE_COMMAND,
    ]);

    vscodeHarness.state.messageResult = "Configure";
    await vscodeHarness.state.commands.get(CONFIGURE_CODEX_COMMAND)!();
    await vscodeHarness.state.commands.get(CONFIGURE_CLAUDE_COMMAND)!();

    expect(await fs.readFile(path.join(root, ".codex", "config.toml"), "utf8"))
      .toContain("unity-debugger-pure-mcp==0.1.0");
    expect(JSON.parse(await fs.readFile(path.join(root, ".mcp.json"), "utf8")))
      .toMatchObject({ mcpServers: { unity_debugger_pure: { command: "uvx" } } });
    registration.dispose();
    expect(vscodeHarness.state.commands.size).toBe(0);
  });

  it("shows named local folders in a picker and opens the exact configuration", async () => {
    const first = await temporaryRoot();
    const second = await temporaryRoot();
    vscodeHarness.state.folders = [
      { name: "First", uri: { scheme: "file", fsPath: first } },
      { name: "Second", uri: { scheme: "file", fsPath: second } },
    ];
    vscodeHarness.state.quickPickResult = {
      label: "Second",
      description: second,
      folder: { name: "Second", scheme: "file", fsPath: second },
    };
    vscodeHarness.state.messageResult = "Configure";
    createVscodeExternalClientCommands(context());
    await vscodeHarness.state.commands.get(CONFIGURE_CODEX_COMMAND)!();

    const items = (vscodeHarness.state.quickPickCalls[0] as [unknown[]])[0];
    expect(items).toEqual([
      { label: "First", description: first, folder: { name: "First", scheme: "file", fsPath: first } },
      { label: "Second", description: second, folder: { name: "Second", scheme: "file", fsPath: second } },
    ]);

    vscodeHarness.state.messageResult = "Open Configuration";
    await vscodeHarness.state.commands.get(CONFIGURE_CODEX_COMMAND)!();
    expect(vscodeHarness.state.opened).toEqual([
      path.join(second, ".codex", "config.toml"),
    ]);
  });

  it("uses modal approved labels and persists Claude ownership in workspaceState", async () => {
    const root = await temporaryRoot();
    const extensionContext = context();
    vscodeHarness.state.folders = [{
      name: "Project",
      uri: { scheme: "file", fsPath: root },
    }];
    vscodeHarness.state.messageResult = "Configure";
    createVscodeExternalClientCommands(extensionContext);

    await vscodeHarness.state.commands.get(CONFIGURE_CLAUDE_COMMAND)!();

    expect(vscodeHarness.state.informationCalls[0]).toEqual([
      "Claude Code is not configured for this project.",
      { modal: true },
      "Configure",
    ]);
    const stored = extensionContext.workspaceState.get<Record<string, unknown>>(
      "externalClientConfigOwnership.v1",
    );
    expect(Object.keys(stored ?? {})).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(root);
  });
});
