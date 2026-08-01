import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

import type { ExternalConfigRelativePath } from "./externalLauncherDescriptor.js";

export const MAX_EXTERNAL_CONFIG_BYTES = 256 * 1024;

const ALLOWED_RELATIVE_PATHS = new Set<ExternalConfigRelativePath>([
  ".codex/config.toml",
  ".mcp.json",
]);

const ERROR_MESSAGES = Object.freeze({
  CONFIG_NOT_ALLOWED: "The project configuration file is not allowed.",
  CONFIG_TOO_LARGE: "The project configuration file is too large.",
  CONFIG_CHANGED: "The project configuration changed. Run the command again.",
  CONFIG_WRITE_FAILED: "The project configuration could not be updated.",
});

export interface WorkspaceFileSnapshot {
  readonly exists: boolean;
  readonly bytes: Buffer;
  readonly revision: string | null;
  readonly bom: boolean;
  readonly newline: "\n" | "\r\n";
}

export type ExternalConfigFileErrorCode = keyof typeof ERROR_MESSAGES;

interface PathIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

interface DirectoryIdentity {
  readonly entry: PathIdentity;
  readonly target: PathIdentity;
}

export class ExternalConfigFileError extends Error {
  public constructor(public readonly code: ExternalConfigFileErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ExternalConfigFileError";
  }
}

export class AtomicWorkspaceFile {
  readonly #canonicalRoot: string;
  readonly #relativePath: ExternalConfigRelativePath;
  readonly #filePath: string;
  readonly #workspaceIdentity: string;

  private constructor(
    canonicalRoot: string,
    relativePath: ExternalConfigRelativePath,
  ) {
    this.#canonicalRoot = canonicalRoot;
    this.#relativePath = relativePath;
    this.#filePath = path.join(canonicalRoot, ...relativePath.split("/"));
    this.#workspaceIdentity = sha256(
      Buffer.from(canonicalRoot.toLowerCase(), "utf8"),
    );
  }

  public static async create(options: {
    readonly workspaceRoot: string;
    readonly relativePath: ExternalConfigRelativePath;
  }): Promise<AtomicWorkspaceFile> {
    if (
      typeof options.workspaceRoot !== "string" ||
      !path.isAbsolute(options.workspaceRoot) ||
      !ALLOWED_RELATIVE_PATHS.has(options.relativePath)
    ) {
      throw new ExternalConfigFileError("CONFIG_NOT_ALLOWED");
    }

    try {
      const canonicalRoot = path.resolve(await fs.realpath(options.workspaceRoot));
      const rootStatus = await fs.stat(canonicalRoot);
      if (!rootStatus.isDirectory()) {
        throw new ExternalConfigFileError("CONFIG_NOT_ALLOWED");
      }
      return new AtomicWorkspaceFile(canonicalRoot, options.relativePath);
    } catch (error) {
      if (error instanceof ExternalConfigFileError) {
        throw error;
      }
      throw new ExternalConfigFileError("CONFIG_NOT_ALLOWED");
    }
  }

  public get filePath(): string {
    return this.#filePath;
  }

  public get workspaceIdentity(): string {
    return this.#workspaceIdentity;
  }

  public async read(): Promise<WorkspaceFileSnapshot> {
    const exists = await this.#validateExistingComponents();
    if (!exists) {
      return absentSnapshot();
    }

    try {
      const handle = await fs.open(this.#filePath, fsConstants.O_RDONLY);
      try {
        const status = await handle.stat();
        if (!status.isFile()) {
          throw new ExternalConfigFileError("CONFIG_NOT_ALLOWED");
        }
        if (status.size > MAX_EXTERNAL_CONFIG_BYTES) {
          throw new ExternalConfigFileError("CONFIG_TOO_LARGE");
        }
        const bytes = await handle.readFile();
        if (bytes.length > MAX_EXTERNAL_CONFIG_BYTES) {
          throw new ExternalConfigFileError("CONFIG_TOO_LARGE");
        }
        return Object.freeze({
          exists: true,
          bytes,
          revision: sha256(bytes),
          bom: hasUtf8Bom(bytes),
          newline: detectNewline(bytes),
        });
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error instanceof ExternalConfigFileError) {
        throw error;
      }
      throw new ExternalConfigFileError("CONFIG_NOT_ALLOWED");
    }
  }

  public async replace(
    expected: WorkspaceFileSnapshot,
    nextBytes: Buffer,
  ): Promise<WorkspaceFileSnapshot> {
    if (!Buffer.isBuffer(nextBytes) || nextBytes.length > MAX_EXTERNAL_CONFIG_BYTES) {
      throw new ExternalConfigFileError("CONFIG_TOO_LARGE");
    }
    const durableBytes = Buffer.from(nextBytes);

    const current = await this.read();
    if (!sameRevision(current, expected)) {
      throw new ExternalConfigFileError("CONFIG_CHANGED");
    }

    const parent = path.dirname(this.#filePath);
    let temporaryPath: string | undefined;
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      await this.#createAndValidateParent(parent);
      const parentIdentity = await this.#captureDirectoryIdentity(parent);
      temporaryPath = path.join(parent, temporaryName(path.basename(this.#filePath)));
      handle = await fs.open(
        temporaryPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        0o600,
      );
      const temporaryIdentity = await this.#validateOpenTemporary(
        parent,
        parentIdentity,
        temporaryPath,
        handle,
      );
      await handle.writeFile(durableBytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.#validateClosedTemporary(
        parent,
        parentIdentity,
        temporaryPath,
        temporaryIdentity,
      );
      const beforeMutation = await this.read();
      if (!sameRevision(beforeMutation, expected)) {
        throw new ExternalConfigFileError("CONFIG_CHANGED");
      }
      await this.#validateClosedTemporary(
        parent,
        parentIdentity,
        temporaryPath,
        temporaryIdentity,
      );
      if (expected.exists) {
        await fs.rename(temporaryPath, this.#filePath);
        temporaryPath = undefined;
      } else {
        try {
          await fs.link(temporaryPath, this.#filePath);
        } catch (error) {
          if (isAlreadyExists(error)) {
            throw new ExternalConfigFileError("CONFIG_CHANGED");
          }
          throw error;
        }
        try {
          await fs.unlink(temporaryPath);
          temporaryPath = undefined;
        } catch {
          // The finally block retries best-effort cleanup without undoing the
          // already published, non-overwriting hard link.
        }
      }
      return snapshotFromBytes(durableBytes);
    } catch (error) {
      if (error instanceof ExternalConfigFileError) {
        throw error;
      }
      throw new ExternalConfigFileError("CONFIG_WRITE_FAILED");
    } finally {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }
      if (temporaryPath !== undefined) {
        await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      }
    }
  }

  public async remove(expected: WorkspaceFileSnapshot): Promise<void> {
    const current = await this.read();
    if (!expected.exists || !sameRevision(current, expected)) {
      throw new ExternalConfigFileError("CONFIG_CHANGED");
    }
    try {
      if (!(await this.#validateExistingComponents())) {
        throw new ExternalConfigFileError("CONFIG_CHANGED");
      }
      const beforeMutation = await this.read();
      if (!sameRevision(beforeMutation, expected)) {
        throw new ExternalConfigFileError("CONFIG_CHANGED");
      }
      await fs.unlink(this.#filePath);
    } catch (error) {
      if (error instanceof ExternalConfigFileError) {
        throw error;
      }
      throw new ExternalConfigFileError("CONFIG_WRITE_FAILED");
    }
  }

  async #createAndValidateParent(parent: string): Promise<void> {
    if (!containsPath(this.#canonicalRoot, parent)) {
      throw new ExternalConfigFileError("CONFIG_NOT_ALLOWED");
    }
    try {
      await fs.mkdir(parent, { recursive: true });
    } catch {
      throw new ExternalConfigFileError("CONFIG_WRITE_FAILED");
    }
    await this.#validateExistingComponents();
  }

  async #captureDirectoryIdentity(parent: string): Promise<DirectoryIdentity> {
    try {
      const entryStatus = await fs.lstat(parent, { bigint: true });
      const resolved = await fs.realpath(parent);
      if (!containsPath(this.#canonicalRoot, resolved)) {
        throw new ExternalConfigFileError("CONFIG_NOT_ALLOWED");
      }
      const targetStatus = await fs.stat(resolved, { bigint: true });
      if (!targetStatus.isDirectory()) {
        throw new ExternalConfigFileError("CONFIG_NOT_ALLOWED");
      }
      return Object.freeze({
        entry: pathIdentity(entryStatus),
        target: pathIdentity(targetStatus),
      });
    } catch (error) {
      if (error instanceof ExternalConfigFileError) {
        throw error;
      }
      throw new ExternalConfigFileError("CONFIG_NOT_ALLOWED");
    }
  }

  async #validateOpenTemporary(
    parent: string,
    parentIdentity: DirectoryIdentity,
    temporaryPath: string,
    handle: Awaited<ReturnType<typeof fs.open>>,
  ): Promise<PathIdentity> {
    try {
      await this.#validateDirectoryIdentity(parent, parentIdentity);
      const handleStatus = await handle.stat({ bigint: true });
      const pathStatus = await fs.lstat(temporaryPath, { bigint: true });
      const resolved = await fs.realpath(temporaryPath);
      if (
        !handleStatus.isFile() ||
        !pathStatus.isFile() ||
        !containsPath(this.#canonicalRoot, resolved) ||
        !samePathIdentity(pathIdentity(handleStatus), pathIdentity(pathStatus))
      ) {
        throw new ExternalConfigFileError("CONFIG_NOT_ALLOWED");
      }
      return pathIdentity(handleStatus);
    } catch (error) {
      if (error instanceof ExternalConfigFileError) {
        throw error;
      }
      throw new ExternalConfigFileError("CONFIG_NOT_ALLOWED");
    }
  }

  async #validateClosedTemporary(
    parent: string,
    parentIdentity: DirectoryIdentity,
    temporaryPath: string,
    temporaryIdentity: PathIdentity,
  ): Promise<void> {
    try {
      await this.#validateDirectoryIdentity(parent, parentIdentity);
      const status = await fs.lstat(temporaryPath, { bigint: true });
      const resolved = await fs.realpath(temporaryPath);
      if (
        !status.isFile() ||
        !containsPath(this.#canonicalRoot, resolved) ||
        !samePathIdentity(pathIdentity(status), temporaryIdentity)
      ) {
        throw new ExternalConfigFileError("CONFIG_NOT_ALLOWED");
      }
    } catch (error) {
      if (error instanceof ExternalConfigFileError) {
        throw error;
      }
      throw new ExternalConfigFileError("CONFIG_NOT_ALLOWED");
    }
  }

  async #validateDirectoryIdentity(
    parent: string,
    expected: DirectoryIdentity,
  ): Promise<void> {
    const actual = await this.#captureDirectoryIdentity(parent);
    if (
      !samePathIdentity(actual.entry, expected.entry) ||
      !samePathIdentity(actual.target, expected.target)
    ) {
      throw new ExternalConfigFileError("CONFIG_NOT_ALLOWED");
    }
  }

  async #validateExistingComponents(): Promise<boolean> {
    let current = this.#canonicalRoot;
    const components = this.#relativePath.split("/");
    for (let index = 0; index < components.length; index += 1) {
      current = path.join(current, components[index]!);
      let status;
      try {
        status = await fs.lstat(current);
      } catch (error) {
        if (isMissing(error)) {
          return false;
        }
        throw new ExternalConfigFileError("CONFIG_NOT_ALLOWED");
      }

      let resolved: string;
      try {
        resolved = await fs.realpath(current);
      } catch {
        throw new ExternalConfigFileError("CONFIG_NOT_ALLOWED");
      }
      if (!containsPath(this.#canonicalRoot, resolved)) {
        throw new ExternalConfigFileError("CONFIG_NOT_ALLOWED");
      }

      const isTarget = index === components.length - 1;
      if (isTarget) {
        if (!status.isFile() && !status.isSymbolicLink()) {
          throw new ExternalConfigFileError("CONFIG_NOT_ALLOWED");
        }
      } else if (!status.isDirectory() && !status.isSymbolicLink()) {
        throw new ExternalConfigFileError("CONFIG_NOT_ALLOWED");
      }
    }
    return true;
  }
}

function absentSnapshot(): WorkspaceFileSnapshot {
  return Object.freeze({
    exists: false,
    bytes: Buffer.alloc(0),
    revision: null,
    bom: false,
    newline: "\n",
  });
}

function snapshotFromBytes(bytes: Buffer): WorkspaceFileSnapshot {
  const snapshotBytes = Buffer.from(bytes);
  return Object.freeze({
    exists: true,
    bytes: snapshotBytes,
    revision: sha256(snapshotBytes),
    bom: hasUtf8Bom(snapshotBytes),
    newline: detectNewline(snapshotBytes),
  });
}

function sameRevision(
  current: WorkspaceFileSnapshot,
  expected: WorkspaceFileSnapshot,
): boolean {
  return current.exists === expected.exists && current.revision === expected.revision;
}

function pathIdentity(status: { readonly dev: bigint; readonly ino: bigint }): PathIdentity {
  return Object.freeze({ device: status.dev, inode: status.ino });
}

function samePathIdentity(left: PathIdentity, right: PathIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function hasUtf8Bom(bytes: Buffer): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

function detectNewline(bytes: Buffer): "\n" | "\r\n" {
  const index = bytes.indexOf(0x0a);
  return index > 0 && bytes[index - 1] === 0x0d ? "\r\n" : "\n";
}

function temporaryName(baseName: string): string {
  const hiddenBase = baseName.startsWith(".") ? baseName : `.${baseName}`;
  return `${hiddenBase}.${randomBytes(16).toString("hex")}.tmp`;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function containsPath(root: string, candidate: string): boolean {
  const relative = path.relative(root.toLowerCase(), path.resolve(candidate).toLowerCase());
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}
