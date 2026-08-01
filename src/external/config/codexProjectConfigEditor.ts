import { parse } from "smol-toml";

import {
  AtomicWorkspaceFile,
  ExternalConfigFileError,
  type WorkspaceFileSnapshot,
} from "./atomicWorkspaceFile.js";
import {
  EXTERNAL_LAUNCHER_ARGS,
  EXTERNAL_LAUNCHER_VERSION,
  RECOGNIZED_EXTERNAL_LAUNCHER_VERSIONS,
  type ExternalConfigAction,
  type ExternalConfigInspection,
  type ProjectConfigEditor,
} from "./externalLauncherDescriptor.js";

export const CODEX_CONFIG_RELATIVE_PATH = ".codex/config.toml";
export const CODEX_MANAGED_BEGIN = "# BEGIN Unity Debugger Pure MCP";
export const CODEX_MANAGED_END = "# END Unity Debugger Pure MCP";

const TARGET_KEYS = Object.freeze([
  "args",
  "command",
  "enabled",
  "required",
  "startup_timeout_sec",
  "tool_timeout_sec",
]);

interface TextRange {
  readonly start: number;
  readonly end: number;
}

interface InspectionDetails {
  readonly public: ExternalConfigInspection;
  readonly snapshot: WorkspaceFileSnapshot;
  readonly text: string;
  readonly targetRange?: TextRange;
  readonly managedRange?: TextRange;
}

interface LineRecord {
  readonly start: number;
  readonly end: number;
  readonly fullEnd: number;
  readonly text: string;
  readonly structural: boolean;
}

export class CodexProjectConfigEditor implements ProjectConfigEditor {
  readonly #file: AtomicWorkspaceFile;

  private constructor(file: AtomicWorkspaceFile) {
    this.#file = file;
  }

  public static async create(workspaceRoot: string): Promise<CodexProjectConfigEditor> {
    return new CodexProjectConfigEditor(await AtomicWorkspaceFile.create({
      workspaceRoot,
      relativePath: CODEX_CONFIG_RELATIVE_PATH,
    }));
  }

  public async inspect(): Promise<ExternalConfigInspection> {
    return (await this.#inspectDetails()).public;
  }

  public async apply(
    action: ExternalConfigAction,
    expected: ExternalConfigInspection,
  ): Promise<ExternalConfigInspection> {
    const details = await this.#inspectDetails();
    if (!sameInspection(details.public, expected) || !actionAllowed(action, details.public.state)) {
      throw new ExternalConfigFileError("CONFIG_CHANGED");
    }

    const newline = details.snapshot.newline;
    const block = managedBlock(newline);
    let nextText: string;
    switch (action) {
      case "configure":
        nextText = appendBlock(details.text, block, newline);
        break;
      case "adopt":
        if (details.targetRange === undefined) {
          throw new ExternalConfigFileError("CONFIG_CHANGED");
        }
        nextText = replaceTarget(details.text, details.targetRange, block, newline);
        break;
      case "update":
        if (details.managedRange === undefined) {
          throw new ExternalConfigFileError("CONFIG_CHANGED");
        }
        nextText = replaceManaged(details.text, details.managedRange, block, newline);
        break;
      case "remove":
        if (details.managedRange === undefined) {
          throw new ExternalConfigFileError("CONFIG_CHANGED");
        }
        nextText = removeManaged(details.text, details.managedRange, newline);
        break;
    }

    const prefix = details.snapshot.bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0);
    await this.#file.replace(
      details.snapshot,
      Buffer.concat([prefix, Buffer.from(nextText, "utf8")]),
    );
    return this.inspect();
  }

  async #inspectDetails(): Promise<InspectionDetails> {
    const snapshot = await this.#file.read();
    if (!snapshot.exists) {
      return {
        public: inspection(this.#file.filePath, snapshot, "absent"),
        snapshot,
        text: "",
      };
    }

    let text: string;
    try {
      const bytes = snapshot.bom ? snapshot.bytes.subarray(3) : snapshot.bytes;
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return {
        public: inspection(this.#file.filePath, snapshot, "conflict"),
        snapshot,
        text: "",
      };
    }

    let document: unknown;
    try {
      document = parse(text);
    } catch {
      return {
        public: inspection(this.#file.filePath, snapshot, "conflict"),
        snapshot,
        text,
      };
    }

    const lines = scanLines(text);
    const targetHeaders = lines.filter((line) =>
      line.structural && isTargetHeader(line.text.trim()));
    const begins = lines.filter((line) =>
      line.structural && line.text.trim() === CODEX_MANAGED_BEGIN);
    const ends = lines.filter((line) =>
      line.structural && line.text.trim() === CODEX_MANAGED_END);
    const targetEntry = findTargetEntry(document);
    const target = targetEntry.value;

    if (target === undefined) {
      const state = !targetEntry.present && targetHeaders.length === 0 && begins.length === 0 && ends.length === 0
        ? "absent"
        : "conflict";
      return {
        public: inspection(this.#file.filePath, snapshot, state),
        snapshot,
        text,
      };
    }

    const launcherVersion = canonicalLauncherVersion(target);
    if (targetHeaders.length !== 1 || launcherVersion === undefined) {
      return {
        public: inspection(this.#file.filePath, snapshot, "conflict"),
        snapshot,
        text,
      };
    }

    const targetHeader = targetHeaders[0]!;
    const nextHeader = lines.find((line) =>
      line.structural && line.start > targetHeader.start && isAnyTableHeader(line.text.trim()));
    const targetRange = Object.freeze({
      start: targetHeader.start,
      end: nextHeader?.start ?? text.length,
    });
    const recognized = RECOGNIZED_EXTERNAL_LAUNCHER_VERSIONS.includes(
      launcherVersion as typeof EXTERNAL_LAUNCHER_VERSION,
    );
    if (!recognized) {
      return {
        public: inspection(this.#file.filePath, snapshot, "conflict"),
        snapshot,
        text,
      };
    }
    const hasMarkers = begins.length > 0 || ends.length > 0;
    if (!hasMarkers) {
      return {
        public: inspection(
          this.#file.filePath,
          snapshot,
          "compatible-unmanaged",
          launcherVersion,
        ),
        snapshot,
        text,
        targetRange,
      };
    }

    if (
      begins.length !== 1 ||
      ends.length !== 1 ||
      begins[0]!.start >= targetHeader.start ||
      ends[0]!.start <= targetHeader.start ||
      (nextHeader !== undefined && ends[0]!.start >= nextHeader.start) ||
      text.slice(begins[0]!.fullEnd, targetHeader.start).trim() !== "" ||
      lines.some((line) =>
        line.start >= ends[0]!.fullEnd &&
        line.start < targetRange.end &&
        line.text.trim() !== "" &&
        !line.text.trimStart().startsWith("#"))
    ) {
      return {
        public: inspection(this.#file.filePath, snapshot, "conflict"),
        snapshot,
        text,
      };
    }

    const state = launcherVersion === EXTERNAL_LAUNCHER_VERSION
      ? "managed-current"
      : "managed-outdated";
    return {
      public: inspection(this.#file.filePath, snapshot, state, launcherVersion),
      snapshot,
      text,
      targetRange,
      managedRange: Object.freeze({
        start: begins[0]!.start,
        end: ends[0]!.fullEnd,
      }),
    };
  }
}

function inspection(
  filePath: string,
  snapshot: WorkspaceFileSnapshot,
  state: ExternalConfigInspection["state"],
  detectedLauncherVersion?: string,
): ExternalConfigInspection {
  return Object.freeze({
    client: "codex",
    state,
    filePath,
    revision: snapshot.revision,
    ...(detectedLauncherVersion === undefined ? {} : { detectedLauncherVersion }),
  });
}

function findTargetEntry(document: unknown): {
  readonly present: boolean;
  readonly value?: Record<string, unknown>;
} {
  if (!isRecord(document)) {
    return { present: false };
  }
  if (!Object.prototype.hasOwnProperty.call(document, "mcp_servers")) {
    return { present: false };
  }
  const servers = document.mcp_servers;
  if (!isRecord(servers)) {
    return { present: true };
  }
  if (!Object.prototype.hasOwnProperty.call(servers, "unity_debugger_pure")) {
    return { present: false };
  }
  const target = servers.unity_debugger_pure;
  return isRecord(target) ? { present: true, value: target } : { present: true };
}

function canonicalLauncherVersion(target: Record<string, unknown>): string | undefined {
  if (
    Object.keys(target).sort().join("\0") !== [...TARGET_KEYS].sort().join("\0") ||
    target.command !== "uvx" ||
    target.startup_timeout_sec !== 60 ||
    target.tool_timeout_sec !== 70 ||
    target.enabled !== true ||
    target.required !== false ||
    !Array.isArray(target.args) ||
    target.args.length !== EXTERNAL_LAUNCHER_ARGS.length ||
    target.args[0] !== EXTERNAL_LAUNCHER_ARGS[0] ||
    target.args[2] !== EXTERNAL_LAUNCHER_ARGS[2] ||
    typeof target.args[1] !== "string"
  ) {
    return undefined;
  }
  const match = /^unity-debugger-pure-mcp==([^\s=]+)$/.exec(target.args[1]);
  return match?.[1];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function actionAllowed(
  action: ExternalConfigAction,
  state: ExternalConfigInspection["state"],
): boolean {
  return (
    (action === "configure" && state === "absent") ||
    (action === "adopt" && state === "compatible-unmanaged") ||
    (action === "update" && state === "managed-outdated") ||
    (action === "remove" && (state === "managed-current" || state === "managed-outdated"))
  );
}

function sameInspection(
  actual: ExternalConfigInspection,
  expected: ExternalConfigInspection,
): boolean {
  return (
    actual.client === expected.client &&
    actual.state === expected.state &&
    actual.filePath === expected.filePath &&
    actual.revision === expected.revision &&
    actual.detectedLauncherVersion === expected.detectedLauncherVersion
  );
}

function managedBlock(newline: "\n" | "\r\n"): string {
  return [
    CODEX_MANAGED_BEGIN,
    "[mcp_servers.unity_debugger_pure]",
    'command = "uvx"',
    "args = [",
    '  "--from",',
    `  "unity-debugger-pure-mcp==${EXTERNAL_LAUNCHER_VERSION}",`,
    '  "unity-debugger-pure-mcp"',
    "]",
    "startup_timeout_sec = 60",
    "tool_timeout_sec = 70",
    "enabled = true",
    "required = false",
    CODEX_MANAGED_END,
  ].join(newline);
}

function appendBlock(text: string, block: string, newline: "\n" | "\r\n"): string {
  if (text.length === 0) {
    return `${block}${newline}`;
  }
  const separator = text.endsWith(`${newline}${newline}`)
    ? ""
    : text.endsWith(newline)
      ? newline
      : `${newline}${newline}`;
  return `${text}${separator}${block}${newline}`;
}

function replaceTarget(
  text: string,
  range: TextRange,
  block: string,
  newline: "\n" | "\r\n",
): string {
  const suffix = text.slice(range.end);
  const replacement = suffix.length === 0 ? `${block}${newline}` : `${block}${newline}${newline}`;
  return `${text.slice(0, range.start)}${replacement}${suffix}`;
}

function replaceManaged(
  text: string,
  range: TextRange,
  block: string,
  newline: "\n" | "\r\n",
): string {
  const suffix = text.slice(range.end);
  const replacement = suffix.length === 0 || suffix.startsWith(newline)
    ? block
    : `${block}${newline}`;
  return `${text.slice(0, range.start)}${replacement}${suffix}`;
}

function removeManaged(
  text: string,
  range: TextRange,
  newline: "\n" | "\r\n",
): string {
  const prefix = text.slice(0, range.start);
  const suffix = text.slice(range.end);
  return `${prefix}${suffix.startsWith(newline) ? suffix.slice(newline.length) : suffix}`;
}

function isTargetHeader(trimmed: string): boolean {
  const servers = String.raw`(?:mcp_servers|"mcp_servers"|'mcp_servers')`;
  const target = String.raw`(?:unity_debugger_pure|"unity_debugger_pure"|'unity_debugger_pure')`;
  return new RegExp(
    String.raw`^\[\s*${servers}\s*\.\s*${target}\s*\](?:\s*#.*)?$`,
    "u",
  ).test(trimmed);
}

function isAnyTableHeader(trimmed: string): boolean {
  return /^\[\[?.*\]\]?(?:\s*#.*)?$/u.test(trimmed);
}

function scanLines(text: string): readonly LineRecord[] {
  const records: LineRecord[] = [];
  let multiline: "basic" | "literal" | undefined;
  let start = 0;
  while (start < text.length) {
    const newlineIndex = text.indexOf("\n", start);
    const fullEnd = newlineIndex === -1 ? text.length : newlineIndex + 1;
    const end = newlineIndex === -1
      ? text.length
      : newlineIndex > start && text[newlineIndex - 1] === "\r"
        ? newlineIndex - 1
        : newlineIndex;
    const line = text.slice(start, end);
    records.push(Object.freeze({
      start,
      end,
      fullEnd,
      text: line,
      structural: multiline === undefined,
    }));
    multiline = scanStringState(line, multiline);
    start = fullEnd;
  }
  return records;
}

function scanStringState(
  line: string,
  initial: "basic" | "literal" | undefined,
): "basic" | "literal" | undefined {
  let multiline = initial;
  let index = 0;
  while (index < line.length) {
    if (multiline !== undefined) {
      const delimiter = multiline === "basic" ? '"""' : "'''";
      const end = line.indexOf(delimiter, index);
      if (end === -1) {
        return multiline;
      }
      multiline = undefined;
      index = end + 3;
      continue;
    }

    const character = line[index]!;
    if (character === "#") {
      break;
    }
    if (line.startsWith('"""', index)) {
      multiline = "basic";
      index += 3;
      continue;
    }
    if (line.startsWith("'''", index)) {
      multiline = "literal";
      index += 3;
      continue;
    }
    if (character === '"') {
      index = skipBasicString(line, index + 1);
      continue;
    }
    if (character === "'") {
      const end = line.indexOf("'", index + 1);
      index = end === -1 ? line.length : end + 1;
      continue;
    }
    index += 1;
  }
  return multiline;
}

function skipBasicString(line: string, start: number): number {
  let escaped = false;
  for (let index = start; index < line.length; index += 1) {
    const character = line[index]!;
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === '"') {
      return index + 1;
    }
  }
  return line.length;
}
