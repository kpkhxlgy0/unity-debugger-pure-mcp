import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => {
  let nextBreakpointId = 1;

  class Position {
    public constructor(
      public readonly line: number,
      public readonly character: number,
    ) {}
  }

  class Location {
    public readonly range: { readonly start: Position; readonly end: Position };

    public constructor(
      public readonly uri: { readonly fsPath: string; readonly scheme: string },
      position: Position,
    ) {
      this.range = { start: position, end: position };
    }
  }

  class Breakpoint {
    public readonly id = `breakpoint-${nextBreakpointId++}`;

    public constructor(
      public readonly enabled = true,
      public readonly condition?: string,
      public readonly hitCondition?: string,
      public readonly logMessage?: string,
    ) {}
  }

  class SourceBreakpoint extends Breakpoint {
    public constructor(
      public readonly location: Location,
      enabled = true,
      condition?: string,
      hitCondition?: string,
      logMessage?: string,
    ) {
      super(enabled, condition, hitCondition, logMessage);
    }
  }

  return {
    Position,
    Location,
    Breakpoint,
    SourceBreakpoint,
    Uri: {
      file: (fsPath: string) => ({ fsPath, scheme: "file" }),
    },
    debug: {
      breakpoints: [],
      addBreakpoints: vi.fn(),
      removeBreakpoints: vi.fn(),
    },
  };
});

import * as vscode from "vscode";

import { BreakpointRegistry } from "../../mcp-extension/src/debug/breakpointRegistry.js";

const workspaceRoot = "H:\\workspace\\MyGame";
const sourcePath = `${workspaceRoot}\\Assets\\Player.cs`;

function registry(): BreakpointRegistry {
  return new BreakpointRegistry({
    canonicalizePath: (value) => path.win32.resolve(value),
    randomBytes: () => Buffer.alloc(32, 0x5a),
  });
}

function setBreakpoints(breakpoints: readonly vscode.Breakpoint[]): void {
  (vscode.debug as { breakpoints: readonly vscode.Breakpoint[] }).breakpoints = breakpoints;
}

describe("BreakpointRegistry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setBreakpoints([]);
  });

  it("removes only the exact MCP-created SourceBreakpoint object", () => {
    const userBreakpoint = new vscode.SourceBreakpoint(
      new vscode.Location(vscode.Uri.file(sourcePath), new vscode.Position(3, 0)),
    );
    setBreakpoints([userBreakpoint]);
    const breakpoints = registry();

    const created = breakpoints.add(
      { sourcePath, line: 12, condition: "health <= 0" },
      [workspaceRoot],
    );
    const addedObject = vi.mocked(vscode.debug.addBreakpoints).mock.calls[0][0][0];
    setBreakpoints([userBreakpoint, addedObject]);

    const listed = breakpoints.list([workspaceRoot]);
    expect(listed).toEqual([
      {
        kind: "source",
        sourcePath,
        line: 4,
        enabled: true,
        conditional: false,
        ownedByMcp: false,
        removable: false,
      },
      {
        kind: "source",
        sourcePath,
        line: 12,
        enabled: true,
        conditional: true,
        ownedByMcp: true,
        removable: true,
        breakpointRef: created.breakpointRef,
      },
    ]);
    expect(JSON.stringify(listed)).not.toContain("health <= 0");

    breakpoints.remove(created.breakpointRef);

    expect(vscode.debug.removeBreakpoints).toHaveBeenCalledOnce();
    expect(vscode.debug.removeBreakpoints).toHaveBeenCalledWith([addedObject]);
    expect(vi.mocked(vscode.debug.removeBreakpoints).mock.calls[0][0]).not.toContain(
      userBreakpoint,
    );
  });

  it("invalidates an opaque ref when the owned breakpoint is removed in the UI", () => {
    const userBreakpoint = new vscode.SourceBreakpoint(
      new vscode.Location(vscode.Uri.file(sourcePath), new vscode.Position(8, 0)),
    );
    setBreakpoints([userBreakpoint]);
    const breakpoints = registry();
    const created = breakpoints.add({ sourcePath, line: 19 }, [workspaceRoot]);
    const owned = vi.mocked(vscode.debug.addBreakpoints).mock.calls.at(-1)![0][0];

    breakpoints.acceptChanges({ added: [], changed: [], removed: [owned] });
    breakpoints.acceptChanges({ added: [], changed: [], removed: [userBreakpoint] });

    expect(() => breakpoints.remove(created.breakpointRef)).toThrowError({
      code: "STALE_REFERENCE",
      message: "The debugger reference is stale or invalid.",
      retryable: false,
      currentState: "reference_invalid",
      action: "Request fresh debugger data and retry with its opaque reference.",
    });
    expect(vscode.debug.removeBreakpoints).not.toHaveBeenCalled();
  });

  it("creates the exact canonical URI, zero-based VS Code position, and condition", () => {
    const breakpoints = registry();

    breakpoints.add(
      {
        sourcePath: `${workspaceRoot}\\Assets\\Scripts\\..\\Player.cs`,
        line: 7,
        condition: "ready && count > 1",
      },
      [workspaceRoot],
    );

    const created = vi.mocked(vscode.debug.addBreakpoints).mock.calls.at(-1)![0][0];
    expect(created).toBeInstanceOf(vscode.SourceBreakpoint);
    const source = created as vscode.SourceBreakpoint;
    expect(source.location.uri.fsPath).toBe(sourcePath);
    expect(source.location.range.start.line).toBe(6);
    expect(source.condition).toBe("ready && count > 1");
  });

  it.each([
    `${workspaceRoot}\\..\\OtherGame\\Secret.cs`,
    "C:\\private\\Secret.cs",
    workspaceRoot,
  ])("rejects traversal or out-of-root source paths without leaking them: %s", (attempt) => {
    const breakpoints = registry();

    expect(() => breakpoints.add({ sourcePath: attempt, line: 1 }, [workspaceRoot]))
      .toThrowError({
        code: "WORKSPACE_NOT_ALLOWED",
        message: "The requested debugger resource is outside the current workspace.",
        retryable: false,
        currentState: "workspace_not_allowed",
        action: "Use a source file from the current trusted workspace.",
      });
    expect(vscode.debug.addBreakpoints).not.toHaveBeenCalled();
  });

  it("never revives a removed ref and retains only live ownership records", () => {
    const breakpoints = registry();
    const first = breakpoints.add({ sourcePath, line: 1 }, [workspaceRoot]);
    const firstObject = vi.mocked(vscode.debug.addBreakpoints).mock.calls.at(-1)![0][0];
    breakpoints.acceptChanges({ added: [], changed: [], removed: [firstObject] });
    const second = breakpoints.add({ sourcePath, line: 2 }, [workspaceRoot]);

    expect(second.breakpointRef).not.toBe(first.breakpointRef);
    expect(breakpoints.activeOwnedCount).toBe(1);
    expect(() => breakpoints.remove(first.breakpointRef)).toThrowError(
      expect.objectContaining({ code: "STALE_REFERENCE" }),
    );
  });

  it("lists user breakpoints read-only and omits source paths outside workspace roots", () => {
    const inside = new vscode.SourceBreakpoint(
      new vscode.Location(vscode.Uri.file(sourcePath), new vscode.Position(2, 0)),
      false,
      "secret-user-condition",
    );
    const outside = new vscode.SourceBreakpoint(
      new vscode.Location(
        vscode.Uri.file("C:\\private\\Outside.cs"),
        new vscode.Position(4, 0),
      ),
    );
    setBreakpoints([outside, inside, outside]);

    const listed = registry().list([workspaceRoot]);

    expect(listed).toEqual([{
      kind: "source",
      sourcePath,
      line: 3,
      enabled: false,
      conditional: true,
      ownedByMcp: false,
      removable: false,
    }]);
    expect(JSON.stringify(listed)).not.toContain("secret-user-condition");
    expect(JSON.stringify(listed)).not.toContain("private");
  });

  it("uses the default realpath boundary for real files and rejects missing or linked escapes", () => {
    const temporaryRoot = mkdtempSync(
      path.join(os.tmpdir(), "unity-debugger-mcp-breakpoints-"),
    );
    const workspace = path.join(temporaryRoot, "workspace");
    const outside = path.join(temporaryRoot, "outside");
    const realSource = path.join(workspace, "Assets", "Player.cs");
    const missingSource = path.join(workspace, "Assets", "Missing.cs");
    const outsideSource = path.join(outside, "Secret.cs");
    const linkedDirectory = path.join(workspace, "LinkedOutside");
    try {
      mkdirSync(path.dirname(realSource), { recursive: true });
      mkdirSync(outside, { recursive: true });
      writeFileSync(realSource, "internal sealed class Player {}\n", "utf8");
      writeFileSync(outsideSource, "internal sealed class Secret {}\n", "utf8");
      symlinkSync(
        outside,
        linkedDirectory,
        process.platform === "win32" ? "junction" : "dir",
      );
      const breakpoints = new BreakpointRegistry({
        randomBytes: () => Buffer.alloc(32, 0x4b),
      });

      expect(() => breakpoints.add({ sourcePath: realSource, line: 1 }, [workspace]))
        .not.toThrow();
      expect(() => breakpoints.add({ sourcePath: missingSource, line: 1 }, [workspace]))
        .toThrowError(expect.objectContaining({ code: "WORKSPACE_NOT_ALLOWED" }));
      expect(() => breakpoints.add({
        sourcePath: path.join(linkedDirectory, "Secret.cs"),
        line: 1,
      }, [workspace])).toThrowError(
        expect.objectContaining({ code: "WORKSPACE_NOT_ALLOWED" }),
      );
      expect(vscode.debug.addBreakpoints).toHaveBeenCalledOnce();
    } finally {
      removeValidatedTemporaryDirectory(temporaryRoot);
    }
  });
});

function removeValidatedTemporaryDirectory(temporaryRoot: string): void {
  const resolvedTemporaryRoot = path.resolve(temporaryRoot);
  const resolvedTemporaryBase = path.resolve(os.tmpdir());
  const relative = path.relative(resolvedTemporaryBase, resolvedTemporaryRoot);
  if (
    relative.length === 0 ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Refusing to remove a directory outside the temporary base.");
  }
  rmSync(resolvedTemporaryRoot, { recursive: true, force: true });
}
