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

test("companion tags publish only the audited VSIX to Open VSX and GitHub", () => {
  assert.equal(fs.existsSync(".github/workflows/release.yml"), false);

  const workflow = readWorkflow(".github/workflows/release-companion.yml");
  const build = workflow.jobs["build-companion"];
  const openvsx = workflow.jobs["publish-openvsx"];
  const githubRelease = workflow.jobs["github-release"];
  const buildCommands = runBodies(build);

  assert.deepEqual(workflow.on.push.tags, ["companion-v*"]);
  assert.equal(build["runs-on"], "windows-latest");
  assert.deepEqual(build.permissions, { contents: "read" });
  assert.equal(setupNodeVersion(build), "26.5.0");
  assertUvSetup(build);
  assert.match(buildCommands, /package\.json/);
  assert.match(buildCommands, /companion-v/);
  assert.match(buildCommands, /npm run package:companion/);
  assert.match(buildCommands, /npm run test:package:companion/);
  assert.doesNotMatch(
    buildCommands,
    /package:launcher|test:package:launcher|PyPI|pypi/,
  );

  const upload = build.steps.find((step) =>
    step.uses === "actions/upload-artifact@v4");
  assert.ok(upload, "build job must upload the audited companion release");
  assert.equal(upload.with.name, "companion-release");
  assert.equal(upload.with["if-no-files-found"], "error");
  assert.equal(upload.with["retention-days"], 1);
  assert.deepEqual(lines(upload.with.path), [
    "dist/unity-debugger-pure-mcp-${{ steps.version.outputs.version }}.vsix",
    "dist/unity-debugger-pure-mcp-${{ steps.version.outputs.version }}.vsix.sha256",
  ]);

  assert.equal(openvsx.needs, "build-companion");
  assert.equal(openvsx.environment, "openvsx");
  assert.equal(
    openvsx.steps.some((step) => step.uses === "actions/download-artifact@v4"),
    true,
  );
  const publish = openvsx.steps.find((step) => typeof step.run === "string");
  assert.match(publish.run, /npx --yes ovsx@1\.0\.2 publish/);
  assert.equal(publish.env.OVSX_PAT, "${{ secrets.OVSX_PAT }}");
  assert.doesNotMatch(runBodies(openvsx), /--pat|vsce publish|marketplace/i);

  assert.equal(githubRelease.needs, "publish-openvsx");
  assert.deepEqual(githubRelease.permissions, { contents: "write" });
  assert.match(runBodies(githubRelease), /gh release create/);
  assert.doesNotMatch(runBodies(githubRelease), /\.whl|\.tar\.gz|PyPI|pypi/);
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

function lines(value) {
  return value.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
}
