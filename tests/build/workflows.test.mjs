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

test("release rebuilds and audits versioned VSIX and launcher assets without marketplace publishing", () => {
  const workflow = readWorkflow(".github/workflows/release.yml");
  const job = workflow.jobs.release;
  const commands = runBodies(job);

  assert.deepEqual(workflow.on.push.tags, ["v*"]);
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
  assert.doesNotMatch(commands, /ovsx|vsce publish|marketplace|remote add|uv publish/i);
});

test("release hands only audited launcher distributions to an isolated PyPI OIDC job", () => {
  const workflow = readWorkflow(".github/workflows/release.yml");
  const release = workflow.jobs.release;
  const publish = workflow.jobs["pypi-publish"];

  assert.equal(workflow.permissions, undefined);
  assert.deepEqual(release.permissions, { contents: "write" });

  const upload = release.steps.find((step) =>
    step.uses === "actions/upload-artifact@v4");
  assert.ok(upload, "release job must upload the audited PyPI distributions");
  assert.equal(upload.with.name, "pypi-distributions");
  assert.equal(upload.with["if-no-files-found"], "error");
  assert.deepEqual(
    upload.with.path.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean),
    [
      "dist/launcher/unity_debugger_pure_mcp-0.1.0-py3-none-win_amd64.whl",
      "dist/launcher/unity_debugger_pure_mcp-0.1.0.tar.gz",
    ],
  );

  assert.equal(publish.needs, "release");
  assert.equal(publish["runs-on"], "ubuntu-latest");
  assert.deepEqual(publish.environment, {
    name: "pypi",
    url: "https://pypi.org/p/unity-debugger-pure-mcp",
  });
  assert.deepEqual(publish.permissions, { "id-token": "write" });

  const download = publish.steps.find((step) =>
    step.uses === "actions/download-artifact@v4");
  assert.ok(download, "publisher must download the reviewed distributions");
  assert.deepEqual(download.with, {
    name: "pypi-distributions",
    path: "dist",
  });

  const uploadToPyPi = publish.steps.find((step) =>
    step.uses === "pypa/gh-action-pypi-publish@release/v1");
  assert.ok(uploadToPyPi, "publisher must use the PyPA Trusted Publishing action");
  assert.deepEqual(uploadToPyPi.with, { "packages-dir": "dist" });
  assert.equal(runBodies(publish), "");
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
