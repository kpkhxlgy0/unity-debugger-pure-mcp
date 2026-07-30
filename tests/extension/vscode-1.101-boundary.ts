import {
  McpStdioServerDefinition,
  lm,
  type McpServerDefinitionProvider,
} from "vscode";

const provider: McpServerDefinitionProvider<McpStdioServerDefinition> = {
  provideMcpServerDefinitions: () => [
    new McpStdioServerDefinition(
      "Unity Debugger Pure MCP",
      "mcp-bridge.exe",
      ["--stdio"],
      { UNITY_DEBUGGER_PURE_MCP: "1" },
    ),
  ],
};

export const companionVsCode101Boundary =
  lm.registerMcpServerDefinitionProvider(
    "unity-debugger-pure-mcp.server",
    provider,
  );
