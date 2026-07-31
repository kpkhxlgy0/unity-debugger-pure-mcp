import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  extractStandaloneHistory,
} from "../../scripts/extract-mcp-history.mjs";

const SCRIPT_PATH = path.resolve("scripts", "extract-mcp-history.mjs");

test("extracts only companion commits and preserves their final content", async (t) => {
  const fixture = createFixture(t);

  const report = await extractStandaloneHistory({
    source: fixture.source,
    sourceRef: fixture.head,
    target: fixture.target,
  });

  assert.deepEqual(
    git(fixture.target, ["log", "--reverse", "--format=%s"])
      .trim()
      .split(/\r?\n/),
    [
      "add companion source",
      "change both products",
      "test companion",
    ],
  );
  assert.equal(
    git(fixture.target, [
      "show",
      "HEAD:mcp-extension/src/extension.ts",
    ]),
    git(fixture.source, [
      "show",
      `${fixture.head}:mcp-extension/src/extension.ts`,
    ]),
  );
  assert.equal(
    git(fixture.target, [
      "show",
      "HEAD:tests/mcp-extension/extension.test.ts",
    ]),
    "export const covered = true;\n",
  );
  assert.throws(
    () => git(fixture.target, ["show", "HEAD:extension/src/base.ts"]),
    /Command failed/,
  );
  assert.equal(git(fixture.target, ["remote"]).trim(), "");
  assert.equal(git(fixture.source, ["rev-parse", "HEAD"]).trim(), fixture.head);
  assert.equal(git(fixture.source, ["status", "--porcelain"]), "");
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.sourceCommit, fixture.head);
  assert.equal(report.retainedCommits.length, 3);
  assert.deepEqual(
    Object.keys(report.content).sort(),
    [
      "mcp-extension/src/extension.ts",
      "tests/mcp-extension/extension.test.ts",
    ],
  );
  for (const entry of Object.values(report.content)) {
    assert.match(entry.gitBlob, /^[0-9a-f]{40}$/);
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
  }
});

test("preserves author, committer, dates, subjects, and messages", async (t) => {
  const fixture = createFixture(t);

  const report = await extractStandaloneHistory({
    source: fixture.source,
    sourceRef: fixture.head,
    target: fixture.target,
  });

  assert.equal(report.retainedCommits.length, fixture.retained.length);
  for (let index = 0; index < fixture.retained.length; index += 1) {
    const sourceCommit = fixture.retained[index];
    const targetCommit = report.retainedCommits[index].target;
    assert.equal(
      commitMetadata(fixture.target, targetCommit),
      commitMetadata(fixture.source, sourceCommit),
    );
    assert.equal(
      git(fixture.target, ["show", "-s", "--format=%B", targetCommit]),
      git(fixture.source, ["show", "-s", "--format=%B", sourceCommit]),
    );
  }
});

test("rejects an existing target without changing it", async (t) => {
  const fixture = createFixture(t);
  fs.mkdirSync(fixture.target, { recursive: true });
  const marker = path.join(fixture.target, "keep.txt");
  fs.writeFileSync(marker, "keep", "utf8");

  await assert.rejects(
    extractStandaloneHistory({
      source: fixture.source,
      sourceRef: fixture.head,
      target: fixture.target,
    }),
    /Target path already exists/,
  );

  assert.equal(fs.readFileSync(marker, "utf8"), "keep");
  assert.equal(git(fixture.source, ["rev-parse", "HEAD"]).trim(), fixture.head);
  assert.equal(git(fixture.source, ["status", "--porcelain"]), "");
});

test("rejects a dirty source before creating the target", async (t) => {
  const fixture = createFixture(t);
  fs.writeFileSync(path.join(fixture.source, "untracked.txt"), "dirty", "utf8");

  await assert.rejects(
    extractStandaloneHistory({
      source: fixture.source,
      sourceRef: fixture.head,
      target: fixture.target,
    }),
    /Source repository must have a clean tracked and untracked state/,
  );

  assert.equal(fs.existsSync(fixture.target), false);
  assert.equal(git(fixture.source, ["rev-parse", "HEAD"]).trim(), fixture.head);
});

test("rejects a source ref other than the current head", async (t) => {
  const fixture = createFixture(t);
  const previous = git(fixture.source, ["rev-parse", "HEAD~1"]).trim();

  await assert.rejects(
    extractStandaloneHistory({
      source: fixture.source,
      sourceRef: previous,
      target: fixture.target,
    }),
    /requested HEAD/,
  );

  assert.equal(fs.existsSync(fixture.target), false);
  assert.equal(git(fixture.source, ["rev-parse", "HEAD"]).trim(), fixture.head);
  assert.equal(git(fixture.source, ["status", "--porcelain"]), "");
});

test("rejects a target nested inside the source repository", async (t) => {
  const fixture = createFixture(t);
  const nestedTarget = path.join(fixture.source, "standalone");

  await assert.rejects(
    extractStandaloneHistory({
      source: fixture.source,
      sourceRef: fixture.head,
      target: nestedTarget,
    }),
    /Target must be outside the source repository/,
  );

  assert.equal(fs.existsSync(nestedTarget), false);
  assert.equal(git(fixture.source, ["rev-parse", "HEAD"]).trim(), fixture.head);
  assert.equal(git(fixture.source, ["status", "--porcelain"]), "");
});

test("accepts a source root reached through a Windows directory junction", async (t) => {
  const fixture = createFixture(t);
  const sourceAlias = path.join(path.dirname(fixture.source), "source-alias");
  fs.symlinkSync(fixture.source, sourceAlias, "junction");

  const report = await extractStandaloneHistory({
    source: sourceAlias,
    sourceRef: fixture.head,
    target: fixture.target,
  });

  assert.equal(report.sourceCommit, fixture.head);
  assert.equal(report.retainedCommits.length, fixture.retained.length);
});

test("rejects a nested target reached through the source junction", async (t) => {
  const fixture = createFixture(t);
  const sourceAlias = path.join(path.dirname(fixture.source), "source-alias");
  fs.symlinkSync(fixture.source, sourceAlias, "junction");
  const nestedTarget = path.join(sourceAlias, "standalone");

  await assert.rejects(
    extractStandaloneHistory({
      source: sourceAlias,
      sourceRef: fixture.head,
      target: nestedTarget,
    }),
    /Target must be outside the source repository/,
  );

  assert.equal(fs.existsSync(nestedTarget), false);
  assert.equal(git(fixture.source, ["status", "--porcelain"]), "");
});

test("CLI rejects unknown, relative, and malformed arguments", () => {
  const cases = [
    ["--unknown", "value"],
    [
      "--source",
      ".",
      "--source-ref",
      "0".repeat(40),
      "--target",
      path.resolve("target"),
    ],
    [
      "--source",
      path.resolve("."),
      "--source-ref",
      "not-a-commit",
      "--target",
      path.resolve("target"),
    ],
  ];

  for (const args of cases) {
    const result = spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    assert.notEqual(result.status, 0, `CLI accepted ${args.join(" ")}`);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Unity Debugger Pure MCP history extraction failed/);
  }
});

function createFixture(t) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "unity-debugger-mcp-history-"),
  );
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  fs.mkdirSync(source, { recursive: true });
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  git(source, ["init", "--initial-branch=master"]);
  git(source, ["config", "user.name", "Fixture Committer"]);
  git(source, ["config", "user.email", "committer@example.test"]);

  commit(source, {
    subject: "add debugger source",
    files: {
      "extension/src/base.ts": "export const base = 1;\n",
    },
    authorName: "Debugger Author",
    authorEmail: "debugger@example.test",
    timestamp: "1704067200 +0800",
  });
  const companionSource = commit(source, {
    subject: "add companion source",
    body: "Preserve this complete companion commit message.",
    files: {
      "mcp-extension/src/extension.ts": "export const version = 1;\n",
    },
    authorName: "Companion Author",
    authorEmail: "companion@example.test",
    timestamp: "1704153600 +0800",
  });
  const mixed = commit(source, {
    subject: "change both products",
    files: {
      "extension/src/base.ts": "export const base = 2;\n",
      "mcp-extension/src/extension.ts": "export const version = 2;\n",
    },
    authorName: "Mixed Author",
    authorEmail: "mixed@example.test",
    timestamp: "1704240000 +0800",
  });
  const companionTest = commit(source, {
    subject: "test companion",
    files: {
      "tests/mcp-extension/extension.test.ts":
        "export const covered = true;\n",
    },
    authorName: "Test Author",
    authorEmail: "test@example.test",
    timestamp: "1704326400 +0800",
  });
  commit(source, {
    subject: "change debugger only",
    files: {
      "extension/src/base.ts": "export const base = 3;\n",
    },
    authorName: "Debugger Author",
    authorEmail: "debugger@example.test",
    timestamp: "1704412800 +0800",
  });

  return {
    source,
    target,
    head: git(source, ["rev-parse", "HEAD"]).trim(),
    retained: [companionSource, mixed, companionTest],
  };
}

function commit(repository, options) {
  for (const [relativePath, content] of Object.entries(options.files)) {
    const absolutePath = path.join(repository, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content, "utf8");
  }
  git(repository, ["add", "-A"]);
  const message = options.body === undefined
    ? options.subject
    : `${options.subject}\n\n${options.body}`;
  git(repository, ["commit", "-m", message], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: options.authorName,
      GIT_AUTHOR_EMAIL: options.authorEmail,
      GIT_AUTHOR_DATE: options.timestamp,
      GIT_COMMITTER_NAME: "Fixture Committer",
      GIT_COMMITTER_EMAIL: "committer@example.test",
      GIT_COMMITTER_DATE: options.timestamp,
    },
  });
  return git(repository, ["rev-parse", "HEAD"]).trim();
}

function commitMetadata(repository, commitId) {
  return git(repository, [
    "show",
    "-s",
    "--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%s",
    commitId,
  ]);
}

function git(repository, args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    env: options.env ?? process.env,
    input: options.input,
    timeout: 10_000,
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `Command failed: git ${args.join(" ")}\n` +
        `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}
