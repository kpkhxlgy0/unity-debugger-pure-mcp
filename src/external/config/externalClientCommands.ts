import { promises as fs } from "node:fs";
import path from "node:path";

import * as vscode from "vscode";

import {
  ClaudeProjectConfigEditor,
  type ClaudeOwnershipRecord,
  type ClaudeOwnershipStore,
} from "./claudeProjectConfigEditor.js";
import { CodexProjectConfigEditor } from "./codexProjectConfigEditor.js";
import type {
  ExternalClientKind,
  ExternalConfigAction,
  ExternalConfigInspection,
  ProjectConfigEditor,
} from "./externalLauncherDescriptor.js";

export const CONFIGURE_CODEX_COMMAND = "unityDebuggerPureMcp.configureCodex";
export const CONFIGURE_CLAUDE_COMMAND = "unityDebuggerPureMcp.configureClaudeCode";

const OWNERSHIP_STATE_KEY = "externalClientConfigOwnership.v1";
const WORKSPACE_ERROR = "Open a trusted local workspace folder to configure this client.";
const WORKSPACE_CHANGED_ERROR = "The selected workspace is no longer available or trusted.";
const SAFE_FAILURE = "The project configuration could not be changed safely.";

const ACTIONS_BY_STATE = Object.freeze({
  absent: Object.freeze(["configure"]),
  "managed-current": Object.freeze(["remove", "open"]),
  "managed-outdated": Object.freeze(["update", "remove", "open"]),
  "compatible-unmanaged": Object.freeze(["adopt", "open"]),
  conflict: Object.freeze(["open"]),
} satisfies Record<
  ExternalConfigInspection["state"],
  readonly (ExternalConfigAction | "open")[]
>);

export interface ExternalWorkspaceFolder {
  readonly name: string;
  readonly scheme: string;
  readonly fsPath: string;
}

export interface ExternalClientCommandsBoundary {
  isWorkspaceTrusted(): boolean;
  workspaceFolders(): readonly ExternalWorkspaceFolder[];
  pickWorkspace(
    folders: readonly ExternalWorkspaceFolder[],
  ): Promise<ExternalWorkspaceFolder | undefined>;
  createEditor(
    client: ExternalClientKind,
    root: string,
  ): Promise<ProjectConfigEditor>;
  chooseAction(options: {
    readonly client: ExternalClientKind;
    readonly inspection: ExternalConfigInspection;
    readonly actions: readonly (ExternalConfigAction | "open")[];
  }): Promise<ExternalConfigAction | "open" | undefined>;
  showSuccess(client: ExternalClientKind, filePath: string): Promise<void>;
  showError(message: string): Promise<void>;
  openConfiguration(filePath: string): Promise<void>;
  registerCommand(id: string, handler: () => Promise<void>): { dispose(): void };
}

export function registerExternalClientCommands(
  boundary: ExternalClientCommandsBoundary,
): { dispose(): void } {
  const registrations: Array<{ dispose(): void }> = [];
  try {
    registrations.push(boundary.registerCommand(
      CONFIGURE_CODEX_COMMAND,
      () => runCommand("codex", boundary),
    ));
    registrations.push(boundary.registerCommand(
      CONFIGURE_CLAUDE_COMMAND,
      () => runCommand("claude", boundary),
    ));
  } catch (error) {
    disposeReverse(registrations);
    throw error;
  }

  let disposed = false;
  return {
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      disposeReverse(registrations);
    },
  };
}

export function createVscodeExternalClientCommands(
  context: vscode.ExtensionContext,
): { dispose(): void } {
  const ownership = new WorkspaceStateOwnershipStore(context.workspaceState);
  return registerExternalClientCommands({
    isWorkspaceTrusted: () => vscode.workspace.isTrusted,
    workspaceFolders: () => Object.freeze(
      (vscode.workspace.workspaceFolders ?? []).map((folder) => Object.freeze({
        name: folder.name,
        scheme: folder.uri.scheme,
        fsPath: folder.uri.fsPath,
      })),
    ),
    async pickWorkspace(folders) {
      const items = folders.map((folder) => ({
        label: folder.name,
        description: folder.fsPath,
        folder,
      }));
      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: "Select the project to configure",
      });
      return selected?.folder;
    },
    async createEditor(client, root) {
      return client === "codex"
        ? CodexProjectConfigEditor.create(root)
        : ClaudeProjectConfigEditor.create({ workspaceRoot: root, ownership });
    },
    async chooseAction(options) {
      const labels = options.actions.map(actionLabel);
      const message = stateMessage(options.client, options.inspection.state);
      const selected = options.inspection.state === "conflict"
        ? await vscode.window.showWarningMessage(message, { modal: true }, ...labels)
        : await vscode.window.showInformationMessage(message, { modal: true }, ...labels);
      return selected === undefined ? undefined : actionFromLabel(selected);
    },
    async showSuccess(client) {
      await vscode.window.showInformationMessage(
        client === "codex"
          ? "Codex project configuration updated. Start a new Codex session to load it."
          : "Claude Code project configuration updated. Start a new session and approve its project trust prompt.",
      );
    },
    async showError(message) {
      await vscode.window.showErrorMessage(message);
    },
    async openConfiguration(filePath) {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      await vscode.window.showTextDocument(document);
    },
    registerCommand: (id, handler) => vscode.commands.registerCommand(id, handler),
  });
}

async function runCommand(
  client: ExternalClientKind,
  boundary: ExternalClientCommandsBoundary,
): Promise<void> {
  try {
    if (!boundary.isWorkspaceTrusted()) {
      await boundary.showError(WORKSPACE_ERROR);
      return;
    }
    const folders = boundary.workspaceFolders();
    const localFolders = folders.filter(isEligibleLocalFolder);
    if (localFolders.length === 0) {
      await boundary.showError(WORKSPACE_ERROR);
      return;
    }
    const selected = folders.length === 1
      ? localFolders[0]
      : await boundary.pickWorkspace(localFolders);
    if (selected === undefined) {
      return;
    }

    const canonicalRoot = await fs.realpath(selected.fsPath);
    const editor = await boundary.createEditor(client, selected.fsPath);
    const observed = await editor.inspect();
    if (observed.client !== client || !containsPath(canonicalRoot, observed.filePath)) {
      throw new Error("Invalid editor boundary");
    }
    const allowedActions: readonly (ExternalConfigAction | "open")[] =
      ACTIONS_BY_STATE[observed.state];
    const action = await boundary.chooseAction({
      client,
      inspection: observed,
      actions: allowedActions,
    });
    if (action === undefined) {
      return;
    }
    if (!allowedActions.includes(action)) {
      throw new Error("Invalid configuration action");
    }
    if (!(await selectionRemainsAllowed(boundary, canonicalRoot))) {
      await boundary.showError(WORKSPACE_CHANGED_ERROR);
      return;
    }
    if (action === "open") {
      await boundary.openConfiguration(observed.filePath);
      return;
    }
    const result = await editor.apply(action, observed);
    if (result.client !== client || !containsPath(canonicalRoot, result.filePath)) {
      throw new Error("Invalid editor result");
    }
    await boundary.showSuccess(client, result.filePath);
  } catch {
    await boundary.showError(SAFE_FAILURE);
  }
}

class WorkspaceStateOwnershipStore implements ClaudeOwnershipStore {
  readonly #state: vscode.Memento;

  public constructor(state: vscode.Memento) {
    this.#state = state;
  }

  public async get(workspaceIdentity: string): Promise<ClaudeOwnershipRecord | undefined> {
    const map = this.#state.get<unknown>(OWNERSHIP_STATE_KEY);
    if (!isRecord(map)) {
      return undefined;
    }
    const value = map[workspaceIdentity];
    return isRecord(value) ? value as unknown as ClaudeOwnershipRecord : undefined;
  }

  public async update(
    workspaceIdentity: string,
    value: ClaudeOwnershipRecord | undefined,
  ): Promise<void> {
    const stored = this.#state.get<unknown>(OWNERSHIP_STATE_KEY);
    const next: Record<string, unknown> = isRecord(stored) ? { ...stored } : {};
    if (value === undefined) {
      delete next[workspaceIdentity];
    } else {
      next[workspaceIdentity] = value;
    }
    await this.#state.update(
      OWNERSHIP_STATE_KEY,
      Object.keys(next).length === 0 ? undefined : next,
    );
  }
}

async function selectionRemainsAllowed(
  boundary: ExternalClientCommandsBoundary,
  canonicalRoot: string,
): Promise<boolean> {
  if (!boundary.isWorkspaceTrusted()) {
    return false;
  }
  for (const folder of boundary.workspaceFolders()) {
    if (!isEligibleLocalFolder(folder)) {
      continue;
    }
    try {
      if (samePath(await fs.realpath(folder.fsPath), canonicalRoot)) {
        const currentFolders = boundary.workspaceFolders();
        return boundary.isWorkspaceTrusted() && currentFolders.some((current) =>
          isEligibleLocalFolder(current) && samePath(current.fsPath, folder.fsPath)
        );
      }
    } catch {
      // A missing or unresolvable root is no longer an eligible workspace.
    }
  }
  return false;
}

function isEligibleLocalFolder(folder: ExternalWorkspaceFolder): boolean {
  return folder.scheme === "file" && path.isAbsolute(folder.fsPath);
}

function containsPath(root: string, candidate: string): boolean {
  const relative = path.relative(
    path.resolve(root).toLowerCase(),
    path.resolve(candidate).toLowerCase(),
  );
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function actionLabel(action: ExternalConfigAction | "open"): string {
  switch (action) {
    case "configure": return "Configure";
    case "adopt": return "Adopt Management";
    case "update": return "Update";
    case "remove": return "Remove";
    case "open": return "Open Configuration";
  }
}

function actionFromLabel(label: string): ExternalConfigAction | "open" | undefined {
  switch (label) {
    case "Configure": return "configure";
    case "Adopt Management": return "adopt";
    case "Update": return "update";
    case "Remove": return "remove";
    case "Open Configuration": return "open";
    default: return undefined;
  }
}

function stateMessage(
  client: ExternalClientKind,
  state: ExternalConfigInspection["state"],
): string {
  const name = client === "codex" ? "Codex" : "Claude Code";
  switch (state) {
    case "absent": return `${name} is not configured for this project.`;
    case "managed-current": return `${name} is configured and managed for this project.`;
    case "managed-outdated": return `${name} uses an older managed launcher configuration.`;
    case "compatible-unmanaged": return `${name} is configured but is not managed by this extension.`;
    case "conflict": return `${name} has a conflicting or invalid project configuration.`;
  }
}

function disposeReverse(registrations: Array<{ dispose(): void }>): void {
  for (let index = registrations.length - 1; index >= 0; index -= 1) {
    registrations[index]!.dispose();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
