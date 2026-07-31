import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import yaml from "js-yaml";

test("CI validates the independent package on Windows", () => {
  const workflow = readWorkflow(".github/workflows/ci.yml");
  const job = workflow.jobs.validate;
  const commands = runBodies(job);

  assert.deepEqual(Object.keys(workflow.on).sort(), [
    "pull_request",
    "push",
  ]);
  assert.equal(job["runs-on"], "windows-latest");
  assert.equal(setupNodeVersion(job), "26.5.0");
  assertUvSetup(job);
  assert.match(commands, /npm ci/);
  assert.match(commands, /npm run typecheck/);
  assert.match(commands, /npm test/);
  assert.match(commands, /npm run package/);
  assert.doesNotMatch(commands, /ovsx|publish|remote add/i);
});

test("release rebuilds and audits versioned VSIX and launcher assets without publishing PyPI", () => {
  const workflow = readWorkflow(".github/workflows/release.yml");
  const job = workflow.jobs.release;
  const commands = runBodies(job);

  assert.deepEqual(workflow.on.push.tags, ["v*"]);
  assert.equal(workflow.permissions.contents, "write");
  assert.equal(job["runs-on"], "windows-latest");
  assert.equal(setupNodeVersion(job), "26.5.0");
  assertUvSetup(job);
  assert.match(commands, /npm ci/);
  assert.match(commands, /package\.json/);
  assert.match(commands, /github\.ref_name/);
  assert.match(commands, /npm test/);
  assert.match(commands, /npm run package/);
  assert.match(commands, /verify-mcp-vsix\.mjs/);
  assert.match(commands, /Get-FileHash/);
  assert.match(commands, /unity-debugger-pure-mcp-0\.1\.0\.vsix\.sha256/);
  assert.match(commands, /unity_debugger_pure_mcp-0\.1\.0-py3-none-win_amd64\.whl/);
  assert.match(commands, /unity_debugger_pure_mcp-0\.1\.0\.tar\.gz/);
  assert.match(commands, /gh release create/);
  assert.doesNotMatch(commands, /ovsx|vsce publish|marketplace|remote add|uv publish|pypi/i);
});

function readWorkflow(file) {
  return yaml.load(fs.readFileSync(file, "utf8"));
}

function runBodies(job) {
  return job.steps
    .filter((step) => typeof step.run === "string")
    .map((step) => step.run)
    .join("\n");
}

function setupNodeVersion(job) {
  return job.steps.find((step) =>
    step.uses === "actions/setup-node@v4").with["node-version"];
}

function assertUvSetup(job) {
  const setup = job.steps.find((step) =>
    typeof step.uses === "string" && step.uses.startsWith("astral-sh/setup-uv@"));
  assert.equal(
    setup.uses,
    "astral-sh/setup-uv@08807647e7069bb48b6ef5acd8ec9567f424441b",
  );
  assert.equal(setup.with.version, "0.12.0");
  assert.equal(setup.with["python-version"], "3.10");
}
