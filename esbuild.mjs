import { build } from "esbuild";

await build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  external: ["vscode"],
  format: "cjs",
  logLevel: "info",
  mainFields: ["module", "main"],
  outfile: "dist/extension.cjs",
  platform: "node",
  sourcemap: true,
  target: "node20",
});
