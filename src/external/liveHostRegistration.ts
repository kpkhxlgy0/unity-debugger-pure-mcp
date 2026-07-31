import path from "node:path";

export const LIVE_HOST_SCHEMA_VERSION = 1 as const;
export const LIVE_HOST_HEARTBEAT_MS = 15_000;
export const LIVE_HOST_STALE_MS = 45_000;
export const LIVE_HOST_MAX_RECORD_BYTES = 65_536;

const INVALID_REGISTRATION_MESSAGE = "Live host registration is invalid.";
const PIPE_PREFIX = "\\\\.\\pipe\\unity-debugger-pure-mcp-";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface LiveHostRegistrationV1 {
  readonly schemaVersion: 1;
  readonly instanceId: string;
  readonly ownerPid: number;
  readonly updatedAt: string;
  readonly workspaceRoots: readonly string[];
  readonly bridge: {
    readonly version: string;
    readonly protocolVersion: 1;
    readonly extensionRoot: string;
    readonly executable: string;
    readonly sha256: string;
  };
  readonly pipe: {
    readonly name: string;
    readonly token: string;
  };
}

export function parseLiveHostRegistration(bytes: Buffer): LiveHostRegistrationV1 {
  try {
    if (bytes.byteLength === 0 || bytes.byteLength > LIVE_HOST_MAX_RECORD_BYTES) {
      throw invalidRegistration();
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    if (!hasExactKeys(value, [
      "schemaVersion",
      "instanceId",
      "ownerPid",
      "updatedAt",
      "workspaceRoots",
      "bridge",
      "pipe",
    ])) {
      throw invalidRegistration();
    }
    if (
      value.schemaVersion !== LIVE_HOST_SCHEMA_VERSION ||
      typeof value.instanceId !== "string" ||
      !UUID_PATTERN.test(value.instanceId) ||
      !validPid(value.ownerPid) ||
      typeof value.updatedAt !== "string" ||
      !validIsoTimestamp(value.updatedAt) ||
      !Array.isArray(value.workspaceRoots) ||
      value.workspaceRoots.length === 0 ||
      value.workspaceRoots.length > 32 ||
      !value.workspaceRoots.every(validWindowsPath) ||
      !hasExactKeys(value.bridge, [
        "version",
        "protocolVersion",
        "extensionRoot",
        "executable",
        "sha256",
      ]) ||
      typeof value.bridge.version !== "string" ||
      !VERSION_PATTERN.test(value.bridge.version) ||
      value.bridge.protocolVersion !== 1 ||
      !validWindowsPath(value.bridge.extensionRoot) ||
      !validWindowsPath(value.bridge.executable) ||
      typeof value.bridge.sha256 !== "string" ||
      !SHA256_PATTERN.test(value.bridge.sha256) ||
      !hasExactKeys(value.pipe, ["name", "token"]) ||
      typeof value.pipe.name !== "string" ||
      !value.pipe.name.startsWith(PIPE_PREFIX) ||
      value.pipe.name.length > 512 ||
      typeof value.pipe.token !== "string" ||
      !validToken(value.pipe.token)
    ) {
      throw invalidRegistration();
    }

    return Object.freeze({
      schemaVersion: LIVE_HOST_SCHEMA_VERSION,
      instanceId: value.instanceId,
      ownerPid: value.ownerPid,
      updatedAt: value.updatedAt,
      workspaceRoots: Object.freeze([...value.workspaceRoots]),
      bridge: Object.freeze({
        version: value.bridge.version,
        protocolVersion: 1 as const,
        extensionRoot: value.bridge.extensionRoot,
        executable: value.bridge.executable,
        sha256: value.bridge.sha256,
      }),
      pipe: Object.freeze({
        name: value.pipe.name,
        token: value.pipe.token,
      }),
    });
  } catch (error) {
    if (error instanceof Error && error.message === INVALID_REGISTRATION_MESSAGE) {
      throw error;
    }
    throw invalidRegistration();
  }
}

export function resolveRuntimeRegistryRoot(localAppData: string): string {
  if (!validWindowsPath(localAppData)) {
    throw new Error("The local application-data directory is unavailable.");
  }
  return path.win32.join(
    path.win32.normalize(localAppData),
    "kpk",
    "unity-debugger-pure-mcp",
    "runtime",
    "v1",
  );
}

export function canonicalPathContains(root: string, candidate: string): boolean {
  if (!validWindowsPath(root) || !validWindowsPath(candidate)) {
    return false;
  }
  const relative = path.win32.relative(
    path.win32.normalize(root).toLowerCase(),
    path.win32.normalize(candidate).toLowerCase(),
  );
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.win32.sep}`) &&
    !path.win32.isAbsolute(relative)
  );
}

function hasExactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index]);
}

function validPid(value: unknown): value is number {
  return Number.isSafeInteger(value) &&
    typeof value === "number" &&
    value > 0 &&
    value <= 0x7fff_ffff;
}

function validIsoTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false;
  }
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function validWindowsPath(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4_096 &&
    !value.includes("\0") &&
    path.win32.isAbsolute(value);
}

function validToken(value: string): boolean {
  if (!TOKEN_PATTERN.test(value)) {
    return false;
  }
  try {
    return Buffer.from(value, "base64url").byteLength === 32;
  } catch {
    return false;
  }
}

function invalidRegistration(): Error {
  return new Error(INVALID_REGISTRATION_MESSAGE);
}
