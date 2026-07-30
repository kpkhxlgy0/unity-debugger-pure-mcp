import { createHmac, randomBytes as nodeRandomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";

import {
  dapFailureError,
  staleReferenceError,
  workspaceNotAllowedError,
} from "../tools/errors.js";
import type { AddBreakpointInput } from "../tools/schemas.js";

const SECRET_BYTES = 32;
const AUTHENTICATION_TAG_BYTES = 16;
const REFERENCE_CONTEXT = Buffer.from(
  "unity-debugger-pure-mcp/breakpoint/v1\0",
  "utf8",
);

export interface SourceBreakpointView {
  readonly kind: "source";
  readonly sourcePath: string;
  readonly line: number;
  readonly enabled: boolean;
  readonly conditional: boolean;
  readonly ownedByMcp: boolean;
  readonly removable: boolean;
  readonly breakpointRef?: string;
}

export interface OtherBreakpointView {
  readonly kind: "other";
  readonly enabled: boolean;
  readonly ownedByMcp: false;
  readonly removable: false;
}

export type BreakpointView = SourceBreakpointView | OtherBreakpointView;

export interface OwnedBreakpoint {
  readonly breakpointRef: string;
}

export interface BreakpointChange {
  readonly added: readonly vscode.Breakpoint[];
  readonly removed: readonly vscode.Breakpoint[];
  readonly changed: readonly vscode.Breakpoint[];
}

interface OwnedRecord {
  readonly breakpointRef: string;
  readonly breakpoint: vscode.SourceBreakpoint;
}

export interface BreakpointRegistryOptions {
  readonly getBreakpoints?: () => readonly vscode.Breakpoint[];
  readonly addBreakpoints?: (breakpoints: readonly vscode.Breakpoint[]) => void;
  readonly removeBreakpoints?: (breakpoints: readonly vscode.Breakpoint[]) => void;
  readonly createSourceBreakpoint?: (
    sourcePath: string,
    zeroBasedLine: number,
    condition?: string,
  ) => vscode.SourceBreakpoint;
  readonly isSourceBreakpoint?: (
    breakpoint: vscode.Breakpoint,
  ) => breakpoint is vscode.SourceBreakpoint;
  readonly canonicalizePath?: (value: string) => string;
  readonly randomBytes?: (size: number) => Buffer;
}

/** Owns only the exact SourceBreakpoint objects created through MCP. */
export class BreakpointRegistry {
  readonly #getBreakpoints: () => readonly vscode.Breakpoint[];
  readonly #addBreakpoints: (breakpoints: readonly vscode.Breakpoint[]) => void;
  readonly #removeBreakpoints: (breakpoints: readonly vscode.Breakpoint[]) => void;
  readonly #createSourceBreakpoint: (
    sourcePath: string,
    zeroBasedLine: number,
    condition?: string,
  ) => vscode.SourceBreakpoint;
  readonly #isSourceBreakpoint: (
    breakpoint: vscode.Breakpoint,
  ) => breakpoint is vscode.SourceBreakpoint;
  readonly #canonicalizePath: (value: string) => string;
  readonly #secret: Buffer;
  readonly #byReference = new Map<string, OwnedRecord>();
  readonly #byObject = new Map<vscode.SourceBreakpoint, OwnedRecord>();
  #counter = 0n;

  public constructor(options: BreakpointRegistryOptions = {}) {
    this.#getBreakpoints = options.getBreakpoints ?? (() => vscode.debug.breakpoints);
    this.#addBreakpoints = options.addBreakpoints ?? ((breakpoints) => {
      vscode.debug.addBreakpoints(breakpoints);
    });
    this.#removeBreakpoints = options.removeBreakpoints ?? ((breakpoints) => {
      vscode.debug.removeBreakpoints(breakpoints);
    });
    this.#createSourceBreakpoint = options.createSourceBreakpoint ?? (
      (sourcePath, zeroBasedLine, condition) => new vscode.SourceBreakpoint(
        new vscode.Location(
          vscode.Uri.file(sourcePath),
          new vscode.Position(zeroBasedLine, 0),
        ),
        true,
        condition,
      )
    );
    this.#isSourceBreakpoint = options.isSourceBreakpoint ?? (
      (breakpoint): breakpoint is vscode.SourceBreakpoint =>
        breakpoint instanceof vscode.SourceBreakpoint
    );
    this.#canonicalizePath = options.canonicalizePath ?? canonicalizeExistingPath;
    const secret = (options.randomBytes ?? nodeRandomBytes)(SECRET_BYTES);
    if (secret.byteLength !== SECRET_BYTES) {
      throw new Error("Breakpoint reference entropy source returned an invalid length.");
    }
    this.#secret = Buffer.from(secret);
  }

  public get activeOwnedCount(): number {
    return this.#byReference.size;
  }

  public add(
    input: AddBreakpointInput,
    workspaceRoots: readonly string[],
  ): OwnedBreakpoint {
    const sourcePath = this.#workspaceSourcePath(input.sourcePath, workspaceRoots);
    let breakpoint: vscode.SourceBreakpoint;
    try {
      breakpoint = this.#createSourceBreakpoint(
        sourcePath,
        input.line - 1,
        input.condition,
      );
      this.#addBreakpoints([breakpoint]);
    } catch {
      throw dapFailureError();
    }

    const breakpointRef = this.#nextReference();
    const record = Object.freeze({ breakpointRef, breakpoint });
    this.#byReference.set(breakpointRef, record);
    this.#byObject.set(breakpoint, record);
    return Object.freeze({ breakpointRef });
  }

  public remove(breakpointRef: string): void {
    const record = this.#byReference.get(breakpointRef);
    if (record === undefined) {
      throw staleReferenceError();
    }
    try {
      this.#removeBreakpoints([record.breakpoint]);
    } catch {
      throw dapFailureError();
    }
    this.#forget(record);
  }

  public list(workspaceRoots: readonly string[]): readonly BreakpointView[] {
    let current: readonly vscode.Breakpoint[];
    try {
      current = this.#getBreakpoints();
    } catch {
      throw dapFailureError();
    }

    const result: BreakpointView[] = [];
    try {
      for (const breakpoint of current) {
        if (!this.#isSourceBreakpoint(breakpoint)) {
          result.push(Object.freeze({
            kind: "other",
            enabled: breakpoint.enabled,
            ownedByMcp: false,
            removable: false,
          }));
          continue;
        }

        if (breakpoint.location.uri.scheme !== "file") {
          continue;
        }
        let sourcePath: string;
        try {
          sourcePath = this.#workspaceSourcePath(
            breakpoint.location.uri.fsPath,
            workspaceRoots,
          );
        } catch (error) {
          if (isWorkspaceNotAllowed(error)) {
            continue;
          }
          throw error;
        }
        const owned = this.#byObject.get(breakpoint);
        const view: {
          kind: "source";
          sourcePath: string;
          line: number;
          enabled: boolean;
          conditional: boolean;
          ownedByMcp: boolean;
          removable: boolean;
          breakpointRef?: string;
        } = {
          kind: "source",
          sourcePath,
          line: breakpoint.location.range.start.line + 1,
          enabled: breakpoint.enabled,
          conditional: breakpoint.condition !== undefined,
          ownedByMcp: owned !== undefined,
          removable: owned !== undefined,
        };
        if (owned !== undefined) {
          view.breakpointRef = owned.breakpointRef;
        }
        result.push(Object.freeze(view));
      }
    } catch {
      throw dapFailureError();
    }
    return Object.freeze(result);
  }

  public acceptChanges(event: BreakpointChange): void {
    try {
      for (const breakpoint of event.removed) {
        if (!this.#isSourceBreakpoint(breakpoint)) {
          continue;
        }
        const record = this.#byObject.get(breakpoint);
        if (record !== undefined) {
          this.#forget(record);
        }
      }
    } catch {
      // VS Code owns this notification. A malformed event must not damage
      // unrelated ownership records or escape into the extension host.
    }
  }

  #workspaceSourcePath(
    sourcePath: string,
    workspaceRoots: readonly string[],
  ): string {
    let canonicalSource: string;
    let canonicalRoots: readonly string[];
    try {
      canonicalSource = this.#canonicalizePath(sourcePath);
      canonicalRoots = workspaceRoots.map((root) => this.#canonicalizePath(root));
    } catch {
      throw workspaceNotAllowedError();
    }
    if (!canonicalRoots.some((root) => isChildPath(root, canonicalSource))) {
      throw workspaceNotAllowedError();
    }
    return canonicalSource;
  }

  #nextReference(): string {
    this.#counter += 1n;
    const counter = encodeCounter(this.#counter);
    const tag = createHmac("sha256", this.#secret)
      .update(REFERENCE_CONTEXT)
      .update(counter)
      .digest()
      .subarray(0, AUTHENTICATION_TAG_BYTES);
    return Buffer.concat([counter, tag]).toString("base64url");
  }

  #forget(record: OwnedRecord): void {
    this.#byReference.delete(record.breakpointRef);
    this.#byObject.delete(record.breakpoint);
  }
}

function canonicalizeExistingPath(value: string): string {
  return realpathSync.native(path.resolve(value));
}

function isChildPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
}

function encodeCounter(counter: bigint): Buffer {
  let hex = counter.toString(16);
  if (hex.length % 2 !== 0) {
    hex = `0${hex}`;
  }
  return Buffer.from(hex, "hex");
}

function isWorkspaceNotAllowed(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "WORKSPACE_NOT_ALLOWED";
}
