export const EXTERNAL_MCP_SERVER_NAME = "unity_debugger_pure";
export const EXTERNAL_LAUNCHER_VERSION = "0.1.0";
export const EXTERNAL_LAUNCHER_ARGS = Object.freeze([
  "--from",
  `unity-debugger-pure-mcp==${EXTERNAL_LAUNCHER_VERSION}`,
  "unity-debugger-pure-mcp",
]);
export const RECOGNIZED_EXTERNAL_LAUNCHER_VERSIONS = Object.freeze([
  EXTERNAL_LAUNCHER_VERSION,
]);

export type ExternalClientKind = "codex" | "claude";
export type ExternalConfigRelativePath =
  | ".codex/config.toml"
  | ".mcp.json";
export type ExternalConfigState =
  | "absent"
  | "managed-current"
  | "managed-outdated"
  | "compatible-unmanaged"
  | "conflict";
export type ExternalConfigAction = "configure" | "adopt" | "update" | "remove";

export interface ExternalConfigInspection {
  readonly client: ExternalClientKind;
  readonly state: ExternalConfigState;
  readonly filePath: string;
  readonly revision: string | null;
  readonly detectedLauncherVersion?: string;
}

export interface ProjectConfigEditor {
  inspect(): Promise<ExternalConfigInspection>;
  apply(
    action: ExternalConfigAction,
    expected: ExternalConfigInspection,
  ): Promise<ExternalConfigInspection>;
}
