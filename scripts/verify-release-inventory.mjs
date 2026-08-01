import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  OFFICIAL_RELEASE_NODE_VERSION,
} from "./build-tool-version-policy.mjs";
import { parseRuntimeInventory } from "./runtime-inventory.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const reviewedPath = path.resolve(
  repositoryRoot,
  process.argv[2] ?? "runtime-inventory.json",
);
const generatedPath = path.resolve(
  repositoryRoot,
  process.argv[3] ?? "dist/runtime-inventory.json",
);
const reviewed = parseRuntimeInventory(fs.readFileSync(reviewedPath, "utf8"));
const generated = parseRuntimeInventory(fs.readFileSync(generatedPath, "utf8"));

if (
  reviewed.nodeVersion !== OFFICIAL_RELEASE_NODE_VERSION ||
  generated.nodeVersion !== reviewed.nodeVersion ||
  generated.sha256 !== reviewed.sha256
) {
  throw new Error("Generated SEA does not match the reviewed release inventory.");
}

console.log("Generated SEA matches the reviewed release inventory.");
