import { createHash } from "node:crypto";

import {
  applyEdits,
  modify,
  parse,
  parseTree,
  type FormattingOptions,
  type Node as JsonNode,
  type ParseError,
} from "jsonc-parser";

import {
  AtomicWorkspaceFile,
  ExternalConfigFileError,
  type WorkspaceFileSnapshot,
} from "./atomicWorkspaceFile.js";
import {
  EXTERNAL_LAUNCHER_ARGS,
  EXTERNAL_LAUNCHER_VERSION,
  EXTERNAL_MCP_SERVER_NAME,
  RECOGNIZED_EXTERNAL_LAUNCHER_VERSIONS,
  type ExternalConfigAction,
  type ExternalConfigInspection,
  type ProjectConfigEditor,
} from "./externalLauncherDescriptor.js";

export const CLAUDE_CONFIG_RELATIVE_PATH = ".mcp.json";

const SERVER_KEYS = Object.freeze(["args", "command", "env"]);

export interface ClaudeOwnershipRecord {
  readonly schemaVersion: 1;
  readonly workspaceIdentity: string;
  readonly serverFingerprint: string;
  readonly launcherVersion: string;
}

export interface ClaudeOwnershipStore {
  get(workspaceIdentity: string): Promise<ClaudeOwnershipRecord | undefined>;
  update(
    workspaceIdentity: string,
    value: ClaudeOwnershipRecord | undefined,
  ): Promise<void>;
}

interface InspectionDetails {
  readonly public: ExternalConfigInspection;
  readonly snapshot: WorkspaceFileSnapshot;
  readonly text: string;
  readonly ownershipRecord?: ClaudeOwnershipRecord;
  readonly launcherVersion?: string;
  readonly serverFingerprint?: string;
}

export class ClaudeProjectConfigEditor implements ProjectConfigEditor {
  readonly #file: AtomicWorkspaceFile;
  readonly #ownership: ClaudeOwnershipStore;

  private constructor(file: AtomicWorkspaceFile, ownership: ClaudeOwnershipStore) {
    this.#file = file;
    this.#ownership = ownership;
  }

  public static async create(options: {
    readonly workspaceRoot: string;
    readonly ownership: ClaudeOwnershipStore;
  }): Promise<ClaudeProjectConfigEditor> {
    return new ClaudeProjectConfigEditor(
      await AtomicWorkspaceFile.create({
        workspaceRoot: options.workspaceRoot,
        relativePath: CLAUDE_CONFIG_RELATIVE_PATH,
      }),
      options.ownership,
    );
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

    if (action === "adopt") {
      if (details.serverFingerprint === undefined || details.launcherVersion === undefined) {
        throw new ExternalConfigFileError("CONFIG_CHANGED");
      }
      await this.#publishOwnership(
        ownershipRecord(
          this.#file.workspaceIdentity,
          details.serverFingerprint,
          details.launcherVersion,
        ),
      );
      return this.inspect();
    }

    const nextText = action === "remove"
      ? editServer(details.text, undefined, details.snapshot)
      : editServer(details.text, canonicalServer(), details.snapshot);
    const prefix = details.snapshot.bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0);
    const nextBytes = Buffer.concat([prefix, Buffer.from(nextText, "utf8")]);
    const written = await this.#file.replace(details.snapshot, nextBytes);
    const nextRecord = action === "remove"
      ? undefined
      : ownershipRecord(
        this.#file.workspaceIdentity,
        fingerprint(canonicalServer()),
        EXTERNAL_LAUNCHER_VERSION,
      );

    try {
      await this.#ownership.update(this.#file.workspaceIdentity, nextRecord);
    } catch {
      await this.#restoreOwnership(details.ownershipRecord);
      await this.#restoreFile(details.snapshot, written);
      throw new ExternalConfigFileError("CONFIG_WRITE_FAILED");
    }
    return this.inspect();
  }

  async #inspectDetails(): Promise<InspectionDetails> {
    const snapshot = await this.#file.read();
    const ownershipRecordValue = await this.#ownership.get(this.#file.workspaceIdentity);
    if (!snapshot.exists) {
      return {
        public: inspection(this.#file.filePath, snapshot, "absent"),
        snapshot,
        text: "",
        ownershipRecord: ownershipRecordValue,
      };
    }

    let text: string;
    try {
      const bytes = snapshot.bom ? snapshot.bytes.subarray(3) : snapshot.bytes;
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return conflict(this.#file.filePath, snapshot, "", ownershipRecordValue);
    }

    const errors: ParseError[] = [];
    const options = { allowTrailingComma: false, disallowComments: true } as const;
    const tree = parseTree(text, errors, options);
    const document = parse(text, errors, options) as unknown;
    if (
      errors.length > 0 ||
      tree === undefined ||
      tree.type !== "object" ||
      hasDuplicateObjectKey(tree) ||
      !isRecord(document)
    ) {
      return conflict(this.#file.filePath, snapshot, text, ownershipRecordValue);
    }

    if (!Object.prototype.hasOwnProperty.call(document, "mcpServers")) {
      return absent(this.#file.filePath, snapshot, text, ownershipRecordValue);
    }
    const servers = document.mcpServers;
    if (!isRecord(servers)) {
      return conflict(this.#file.filePath, snapshot, text, ownershipRecordValue);
    }
    if (!Object.prototype.hasOwnProperty.call(servers, EXTERNAL_MCP_SERVER_NAME)) {
      return absent(this.#file.filePath, snapshot, text, ownershipRecordValue);
    }
    const server = servers[EXTERNAL_MCP_SERVER_NAME];
    if (!isRecord(server)) {
      return conflict(this.#file.filePath, snapshot, text, ownershipRecordValue);
    }
    const launcherVersion = canonicalLauncherVersion(server);
    if (
      launcherVersion === undefined ||
      !RECOGNIZED_EXTERNAL_LAUNCHER_VERSIONS.includes(
        launcherVersion as typeof EXTERNAL_LAUNCHER_VERSION,
      )
    ) {
      return conflict(this.#file.filePath, snapshot, text, ownershipRecordValue);
    }

    const serverFingerprint = fingerprint(server);
    if (ownershipRecordValue === undefined) {
      return {
        public: inspection(
          this.#file.filePath,
          snapshot,
          "compatible-unmanaged",
          launcherVersion,
        ),
        snapshot,
        text,
        launcherVersion,
        serverFingerprint,
      };
    }
    if (
      !validOwnershipRecord(ownershipRecordValue) ||
      ownershipRecordValue.workspaceIdentity !== this.#file.workspaceIdentity ||
      ownershipRecordValue.serverFingerprint !== serverFingerprint ||
      ownershipRecordValue.launcherVersion !== launcherVersion
    ) {
      return conflict(this.#file.filePath, snapshot, text, ownershipRecordValue);
    }

    return {
      public: inspection(
        this.#file.filePath,
        snapshot,
        launcherVersion === EXTERNAL_LAUNCHER_VERSION
          ? "managed-current"
          : "managed-outdated",
        launcherVersion,
      ),
      snapshot,
      text,
      ownershipRecord: ownershipRecordValue,
      launcherVersion,
      serverFingerprint,
    };
  }

  async #publishOwnership(value: ClaudeOwnershipRecord): Promise<void> {
    try {
      await this.#ownership.update(this.#file.workspaceIdentity, value);
    } catch {
      throw new ExternalConfigFileError("CONFIG_WRITE_FAILED");
    }
  }

  async #restoreOwnership(value: ClaudeOwnershipRecord | undefined): Promise<void> {
    await this.#ownership.update(this.#file.workspaceIdentity, value).catch(() => undefined);
  }

  async #restoreFile(
    original: WorkspaceFileSnapshot,
    written: WorkspaceFileSnapshot,
  ): Promise<void> {
    try {
      if (original.exists) {
        await this.#file.replace(written, original.bytes);
      } else {
        await this.#file.remove(written);
      }
    } catch {
      // The caller still receives a fixed failure; never expose file state or paths.
    }
  }
}

function canonicalServer(): Record<string, unknown> {
  return {
    command: "uvx",
    args: [...EXTERNAL_LAUNCHER_ARGS],
    env: {},
  };
}

function canonicalLauncherVersion(server: Record<string, unknown>): string | undefined {
  if (
    Object.keys(server).sort().join("\0") !== [...SERVER_KEYS].sort().join("\0") ||
    server.command !== "uvx" ||
    !Array.isArray(server.args) ||
    server.args.length !== EXTERNAL_LAUNCHER_ARGS.length ||
    server.args[0] !== EXTERNAL_LAUNCHER_ARGS[0] ||
    server.args[2] !== EXTERNAL_LAUNCHER_ARGS[2] ||
    typeof server.args[1] !== "string" ||
    !isRecord(server.env) ||
    Object.keys(server.env).length !== 0
  ) {
    return undefined;
  }
  return /^unity-debugger-pure-mcp==([^\s=]+)$/u.exec(server.args[1])?.[1];
}

function editServer(
  text: string,
  value: Record<string, unknown> | undefined,
  snapshot: WorkspaceFileSnapshot,
): string {
  if (text.length === 0 && value !== undefined) {
    return `${JSON.stringify({
      mcpServers: { [EXTERNAL_MCP_SERVER_NAME]: value },
    }, null, 2)}${snapshot.newline}`;
  }
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, {
    allowTrailingComma: false,
    disallowComments: true,
  });
  if (tree === undefined || tree.type !== "object" || errors.length > 0) {
    throw new ExternalConfigFileError("CONFIG_CHANGED");
  }
  const serversProperty = objectProperty(tree, "mcpServers");
  if (serversProperty === undefined) {
    if (value === undefined) {
      throw new ExternalConfigFileError("CONFIG_CHANGED");
    }
    return insertObjectProperty(
      text,
      tree,
      "mcpServers",
      { [EXTERNAL_MCP_SERVER_NAME]: value },
      snapshot,
    );
  }
  const serversNode = serversProperty.children?.[1];
  if (serversNode?.type !== "object") {
    throw new ExternalConfigFileError("CONFIG_CHANGED");
  }
  const targetProperty = objectProperty(serversNode, EXTERNAL_MCP_SERVER_NAME);
  if (targetProperty === undefined) {
    if (value === undefined) {
      throw new ExternalConfigFileError("CONFIG_CHANGED");
    }
    return insertObjectProperty(
      text,
      serversNode,
      EXTERNAL_MCP_SERVER_NAME,
      value,
      snapshot,
    );
  }
  if (value !== undefined) {
    return applyEdits(text, modify(
      text,
      ["mcpServers", EXTERNAL_MCP_SERVER_NAME],
      value,
      { formattingOptions: formattingOptions(text, snapshot) },
    ));
  }
  return removeObjectProperty(text, serversNode, targetProperty);
}

function formattingOptions(
  text: string,
  snapshot: WorkspaceFileSnapshot,
): FormattingOptions {
  const indentation = /^([ \t]+)"/mu.exec(text)?.[1] ?? "  ";
  const insertSpaces = !indentation.includes("\t");
  return {
    insertSpaces,
    tabSize: insertSpaces ? Math.max(1, indentation.length) : 1,
    eol: snapshot.newline,
    insertFinalNewline: !snapshot.exists || text.endsWith(snapshot.newline),
  };
}

function objectProperty(node: JsonNode, name: string): JsonNode | undefined {
  return (node.children ?? []).find((property) =>
    property.type === "property" && property.children?.[0]?.value === name);
}

function insertObjectProperty(
  text: string,
  objectNode: JsonNode,
  name: string,
  value: Record<string, unknown>,
  snapshot: WorkspaceFileSnapshot,
): string {
  const options = formattingOptions(text, snapshot);
  const unit = options.insertSpaces === false
    ? "\t"
    : " ".repeat(options.tabSize ?? 2);
  const objectIndent = lineIndentAt(text, objectNode.offset);
  const propertyIndent = `${objectIndent}${unit}`;
  const propertyText = formatProperty(name, value, propertyIndent, unit, snapshot.newline);
  const properties = objectNode.children ?? [];
  const insertion = properties.length === 0
    ? `${snapshot.newline}${propertyIndent}${propertyText}${snapshot.newline}${objectIndent}`
    : `,${snapshot.newline}${propertyIndent}${propertyText}`;
  const offset = properties.length === 0
    ? objectNode.offset + 1
    : properties[properties.length - 1]!.offset + properties[properties.length - 1]!.length;
  return applyEdits(text, [{ offset, length: 0, content: insertion }]);
}

function removeObjectProperty(
  text: string,
  objectNode: JsonNode,
  target: JsonNode,
): string {
  const properties = objectNode.children ?? [];
  const index = properties.indexOf(target);
  if (index === -1) {
    throw new ExternalConfigFileError("CONFIG_CHANGED");
  }
  let offset = target.offset;
  let end = target.offset + target.length;
  if (index < properties.length - 1) {
    end = properties[index + 1]!.offset;
  } else if (index > 0) {
    offset = properties[index - 1]!.offset + properties[index - 1]!.length;
  }
  return applyEdits(text, [{ offset, length: end - offset, content: "" }]);
}

function lineIndentAt(text: string, offset: number): string {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/u.exec(text.slice(lineStart, offset))?.[0] ?? "";
}

function formatProperty(
  name: string,
  value: Record<string, unknown>,
  propertyIndent: string,
  unit: string,
  newline: "\n" | "\r\n",
): string {
  const valueText = JSON.stringify(value, null, unit);
  return `${JSON.stringify(name)}: ${valueText.replaceAll("\n", `${newline}${propertyIndent}`)}`;
}

function ownershipRecord(
  workspaceIdentity: string,
  serverFingerprint: string,
  launcherVersion: string,
): ClaudeOwnershipRecord {
  return Object.freeze({
    schemaVersion: 1,
    workspaceIdentity,
    serverFingerprint,
    launcherVersion,
  });
}

function fingerprint(value: Record<string, unknown>): string {
  return createHash("sha256")
    .update(Buffer.from(stableStringify(value), "utf8"))
    .digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hasDuplicateObjectKey(node: JsonNode): boolean {
  if (node.type === "object") {
    const keys = new Set<string>();
    for (const property of node.children ?? []) {
      const key = property.children?.[0]?.value;
      if (typeof key !== "string" || keys.has(key)) {
        return true;
      }
      keys.add(key);
    }
  }
  return (node.children ?? []).some(hasDuplicateObjectKey);
}

function validOwnershipRecord(value: ClaudeOwnershipRecord): boolean {
  return (
    value.schemaVersion === 1 &&
    /^[a-f0-9]{64}$/u.test(value.workspaceIdentity) &&
    /^[a-f0-9]{64}$/u.test(value.serverFingerprint) &&
    typeof value.launcherVersion === "string"
  );
}

function inspection(
  filePath: string,
  snapshot: WorkspaceFileSnapshot,
  state: ExternalConfigInspection["state"],
  detectedLauncherVersion?: string,
): ExternalConfigInspection {
  return Object.freeze({
    client: "claude",
    state,
    filePath,
    revision: snapshot.revision,
    ...(detectedLauncherVersion === undefined ? {} : { detectedLauncherVersion }),
  });
}

function absent(
  filePath: string,
  snapshot: WorkspaceFileSnapshot,
  text: string,
  ownershipRecordValue: ClaudeOwnershipRecord | undefined,
): InspectionDetails {
  return {
    public: inspection(filePath, snapshot, "absent"),
    snapshot,
    text,
    ownershipRecord: ownershipRecordValue,
  };
}

function conflict(
  filePath: string,
  snapshot: WorkspaceFileSnapshot,
  text: string,
  ownershipRecordValue: ClaudeOwnershipRecord | undefined,
): InspectionDetails {
  return {
    public: inspection(filePath, snapshot, "conflict"),
    snapshot,
    text,
    ownershipRecord: ownershipRecordValue,
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
