import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const COMPANION_PATHS = Object.freeze([
  "mcp-extension",
  "mcp-server",
  "scripts/build-mcp-bridge.mjs",
  "scripts/mcp-smoke-stdout.mjs",
  "scripts/verify-mcp-vsix.mjs",
  "scripts/extract-mcp-history.mjs",
  "tests/build/mcp-companion-scaffold.test.mjs",
  "tests/build/extract-mcp-history.test.mjs",
  "tests/integration/mcpCompanion.integration.test.ts",
  "tests/mcp-extension",
  "tests/mcp-server",
  "tests/package/mcp-smoke-stdout.test.mjs",
  "tests/package/mcp-vsix.test.mjs",
  "docs/superpowers/specs/2026-07-30-unity-debugger-pure-mcp-companion-design.md",
  "docs/superpowers/specs/2026-07-30-unity-debugger-pure-mcp-repository-split-design.md",
  "docs/superpowers/plans/2026-07-30-mcp-companion-core.md",
  "docs/superpowers/plans/2026-07-30-mcp-external-bridge-release.md",
  "docs/superpowers/plans/2026-07-30-unity-debugger-pure-mcp-repository-split.md",
]);

const SOURCE_REPOSITORY = "kpkhxlgy0/unity-debugger-vscode";
const SOURCE_BRANCH = "feature/unity-debugger-pure-mcp";

export async function extractStandaloneHistory(options) {
  const source = path.resolve(options.source);
  const target = path.resolve(options.target);
  const sourceRoot = git(source, ["rev-parse", "--show-toplevel"]).trim();
  const head = git(source, ["rev-parse", "HEAD"]).trim();

  if (!samePath(source, sourceRoot) || options.sourceRef !== head) {
    throw new Error(
      "Source must be the clean repository root at the requested HEAD.",
    );
  }
  if (git(source, ["status", "--porcelain"]) !== "") {
    throw new Error(
      "Source repository must have a clean tracked and untracked state.",
    );
  }
  if (fs.existsSync(target)) {
    throw new Error("Target path already exists.");
  }
  if (isWithin(source, target)) {
    throw new Error("Target must be outside the source repository.");
  }
  const targetParent = path.dirname(target);
  if (!fs.existsSync(targetParent)) {
    throw new Error("Target parent directory does not exist.");
  }

  let cloned = false;
  try {
    run("git", ["clone", "--no-checkout", "--no-local", source, target], {
      cwd: targetParent,
    });
    cloned = true;
    git(target, ["remote", "remove", "origin"]);

    const sourceCommits = lines(
      git(target, [
        "rev-list",
        "--reverse",
        "--topo-order",
        options.sourceRef,
        "--",
        ...COMPANION_PATHS,
      ]),
    );
    if (sourceCommits.length === 0) {
      throw new Error("No companion history matched the reviewed allowlist.");
    }

    const indexPath = path.join(target, ".git", "mcp-history-index");
    const retainedCommits = [];
    let previousCommit;
    let previousTree;
    try {
      for (const sourceCommit of sourceCommits) {
        const tree = writeFilteredTree(target, sourceCommit, indexPath);
        if (tree === previousTree) {
          continue;
        }
        const metadata = readCommitMetadata(target, sourceCommit);
        const environment = {
          ...process.env,
          GIT_AUTHOR_NAME: metadata.author.name,
          GIT_AUTHOR_EMAIL: metadata.author.email,
          GIT_AUTHOR_DATE:
            `${metadata.author.timestamp} ${metadata.author.timezone}`,
          GIT_COMMITTER_NAME: metadata.committer.name,
          GIT_COMMITTER_EMAIL: metadata.committer.email,
          GIT_COMMITTER_DATE:
            `${metadata.committer.timestamp} ${metadata.committer.timezone}`,
        };
        const commitArguments = ["commit-tree", tree];
        if (previousCommit !== undefined) {
          commitArguments.push("-p", previousCommit);
        }
        const targetCommit = git(target, commitArguments, {
          env: environment,
          input: metadata.message,
        }).trim();
        const identity = readReportIdentity(target, targetCommit);
        retainedCommits.push(Object.freeze({
          source: sourceCommit,
          target: targetCommit,
          subject: identity.subject,
          author: `${identity.authorName} <${identity.authorEmail}>`,
          authorDate: identity.authorDate,
          committer:
            `${identity.committerName} <${identity.committerEmail}>`,
          committerDate: identity.committerDate,
        }));
        previousCommit = targetCommit;
        previousTree = tree;
      }
    } finally {
      fs.rmSync(indexPath, { force: true });
    }

    if (previousCommit === undefined) {
      throw new Error("Companion history became empty after filtering.");
    }
    git(target, ["update-ref", "refs/heads/master", previousCommit]);
    git(target, ["checkout", "--force", "master"]);
    deleteOtherRefs(target);

    const tracked = lines(git(target, ["ls-files"]));
    const unexpected = tracked.filter((file) => !isAllowlisted(file));
    if (unexpected.length > 0) {
      throw new Error(
        `Filtered repository contains unexpected paths: ${unexpected.join(", ")}`,
      );
    }

    const content = verifyFinalContent(
      source,
      options.sourceRef,
      target,
      previousCommit,
    );
    if (git(source, ["rev-parse", "HEAD"]).trim() !== head) {
      throw new Error("Source HEAD changed during extraction.");
    }
    if (git(source, ["status", "--porcelain"]) !== "") {
      throw new Error("Source state changed during extraction.");
    }
    if (git(target, ["remote"]).trim() !== "") {
      throw new Error("Filtered repository retained a Git remote.");
    }
    if (git(target, ["status", "--porcelain"]) !== "") {
      throw new Error("Filtered repository checkout is not clean.");
    }

    return Object.freeze({
      schemaVersion: 1,
      sourceRepository: SOURCE_REPOSITORY,
      sourceBranch: SOURCE_BRANCH,
      sourceCommit: options.sourceRef,
      retainedCommits: Object.freeze(retainedCommits),
      content: Object.freeze(content),
    });
  } catch (error) {
    if (cloned) {
      throw new Error(
        `${errorMessage(error)} Target retained for diagnosis at ${target}.`,
        { cause: error },
      );
    }
    throw error;
  }
}

function writeFilteredTree(repository, commitId, indexPath) {
  fs.rmSync(indexPath, { force: true });
  const environment = {
    ...process.env,
    GIT_INDEX_FILE: indexPath,
  };
  git(repository, ["read-tree", "--empty"], { env: environment });
  const entries = git(repository, [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    commitId,
    "--",
    ...COMPANION_PATHS,
  ]);
  if (entries.length > 0) {
    git(repository, ["update-index", "-z", "--index-info"], {
      env: environment,
      input: entries,
    });
  }
  return git(repository, ["write-tree"], { env: environment }).trim();
}

function readCommitMetadata(repository, commitId) {
  const raw = git(repository, ["cat-file", "commit", commitId]);
  const separator = raw.indexOf("\n\n");
  if (separator < 0) {
    throw new Error(`Commit ${commitId} has no message separator.`);
  }
  const headers = raw.slice(0, separator);
  const author = parseIdentityHeader(headers, "author");
  const committer = parseIdentityHeader(headers, "committer");
  return {
    author,
    committer,
    message: raw.slice(separator + 2),
  };
}

function parseIdentityHeader(headers, kind) {
  const line = headers
    .split("\n")
    .find((candidate) => candidate.startsWith(`${kind} `));
  const match = line?.match(
    /^(?:author|committer) (.*) <([^<>]*)> ([0-9]+) ([+-][0-9]{4})$/,
  );
  if (match === undefined || match === null) {
    throw new Error(`Commit has a malformed ${kind} header.`);
  }
  return {
    name: match[1],
    email: match[2],
    timestamp: match[3],
    timezone: match[4],
  };
}

function readReportIdentity(repository, commitId) {
  const fields = git(repository, [
    "show",
    "-s",
    "--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%s",
    commitId,
  ]).replace(/\r?\n$/, "").split("\0");
  if (fields.length !== 7) {
    throw new Error(`Commit ${commitId} has malformed report metadata.`);
  }
  return {
    authorName: fields[0],
    authorEmail: fields[1],
    authorDate: fields[2],
    committerName: fields[3],
    committerEmail: fields[4],
    committerDate: fields[5],
    subject: fields[6],
  };
}

function deleteOtherRefs(repository) {
  const refs = lines(git(repository, [
    "for-each-ref",
    "--format=%(refname)",
    "refs/heads",
    "refs/remotes",
    "refs/tags",
  ]));
  for (const ref of refs) {
    if (ref !== "refs/heads/master") {
      git(repository, ["update-ref", "-d", ref]);
    }
  }
}

function verifyFinalContent(source, sourceCommit, target, targetCommit) {
  const sourceEntries = readTreeEntries(source, sourceCommit);
  const targetEntries = readTreeEntries(target, targetCommit);
  if (
    JSON.stringify([...sourceEntries.keys()]) !==
      JSON.stringify([...targetEntries.keys()])
  ) {
    throw new Error("Filtered final paths differ from the source commit.");
  }

  const content = {};
  for (const [file, sourceEntry] of sourceEntries) {
    const targetEntry = targetEntries.get(file);
    if (
      targetEntry === undefined ||
      targetEntry.mode !== sourceEntry.mode ||
      targetEntry.object !== sourceEntry.object
    ) {
      throw new Error(`Filtered content differs for ${file}.`);
    }
    const sourceBytes = gitBuffer(source, [
      "cat-file",
      "blob",
      sourceEntry.object,
    ]);
    const targetBytes = gitBuffer(target, [
      "cat-file",
      "blob",
      targetEntry.object,
    ]);
    const sourceDigest = sha256(sourceBytes);
    if (sourceDigest !== sha256(targetBytes)) {
      throw new Error(`Filtered SHA-256 differs for ${file}.`);
    }
    content[file] = Object.freeze({
      gitBlob: sourceEntry.object,
      sha256: sourceDigest,
    });
  }
  return content;
}

function readTreeEntries(repository, commitId) {
  const raw = git(repository, [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    commitId,
    "--",
    ...COMPANION_PATHS,
  ]);
  const entries = new Map();
  for (const record of raw.split("\0")) {
    if (record.length === 0) {
      continue;
    }
    const match = record.match(
      /^([0-7]{6}) (?:blob|commit) ([0-9a-f]{40})\t([\s\S]+)$/,
    );
    if (match === null) {
      throw new Error(`Malformed ls-tree record: ${record}`);
    }
    entries.set(match[3], {
      mode: match[1],
      object: match[2],
    });
  }
  return new Map([...entries].sort(([left], [right]) =>
    left.localeCompare(right)));
}

function isAllowlisted(file) {
  return COMPANION_PATHS.some((allowed) =>
    file === allowed || file.startsWith(`${allowed}/`));
}

function parseCliArguments(args) {
  if (args.length !== 6) {
    throw new Error(
      "Usage: extract-mcp-history.mjs --source <absolute> " +
        "--source-ref <40-hex> --target <absolute>",
    );
  }
  const values = new Map();
  const expected = new Set(["--source", "--source-ref", "--target"]);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      !expected.has(key) ||
      values.has(key) ||
      typeof value !== "string" ||
      value.length === 0
    ) {
      throw new Error("CLI arguments are missing, duplicated, or unknown.");
    }
    values.set(key, value);
  }
  const source = values.get("--source");
  const sourceRef = values.get("--source-ref");
  const target = values.get("--target");
  if (!path.isAbsolute(source) || !path.isAbsolute(target)) {
    throw new Error("Source and target paths must be absolute.");
  }
  if (!/^[0-9a-f]{40}$/.test(sourceRef)) {
    throw new Error("Source ref must be a lowercase 40-hex commit ID.");
  }
  return { source, sourceRef, target };
}

function lines(value) {
  const normalized = value.trim();
  return normalized.length === 0 ? [] : normalized.split(/\r?\n/);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: options.encoding === undefined ? "utf8" : options.encoding,
    env: options.env ?? process.env,
    input: options.input,
    timeout: 60_000,
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `Command failed: ${command} ${args.join(" ")}\n` +
        `${result.error ?? ""}\n${stringifyOutput(result.stdout)}\n` +
        stringifyOutput(result.stderr),
    );
  }
  return result.stdout;
}

function git(repository, args, options = {}) {
  return run("git", args, { ...options, cwd: repository });
}

function gitBuffer(repository, args) {
  return run("git", args, { cwd: repository, encoding: null });
}

function stringifyOutput(value) {
  return Buffer.isBuffer(value) ? value.toString("utf8") : (value ?? "");
}

function samePath(left, right) {
  return normalizedPath(left) === normalizedPath(right);
}

function isWithin(parent, candidate) {
  const parentPath = normalizedPath(parent);
  const candidatePath = normalizedPath(candidate);
  return (
    candidatePath === parentPath ||
    candidatePath.startsWith(`${parentPath}/`)
  );
}

function normalizedPath(value) {
  const normalized = path.resolve(value).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isMainModule() {
  return (
    process.argv[1] !== undefined &&
    samePath(fileURLToPath(import.meta.url), process.argv[1])
  );
}

if (isMainModule()) {
  void (async () => {
    try {
      const report = await extractStandaloneHistory(
        parseCliArguments(process.argv.slice(2)),
      );
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } catch (error) {
      process.stderr.write(
        `Unity Debugger Pure MCP history extraction failed: ` +
          `${errorMessage(error)}\n`,
      );
      process.exitCode = 1;
    }
  })();
}
