import { build } from "esbuild";

await build({
  entryPoints: ["src/server.ts"],
  bundle: true,
  format: "cjs",
  logLevel: "info",
  outfile: "dist/server.cjs",
  platform: "node",
  sourcemap: true,
  target: "node20",
});
