#!/usr/bin/env node
/**
 * Companion to `npm run release:patch / :minor / :major`. Runs after the
 * npm publish has tagged and pushed the new version. Reads the version
 * from package.json, opens the editor with a release-notes template, then
 * calls `gh release create` against the matching tag.
 *
 * Required: GitHub CLI (`gh`) authenticated locally.
 */

import { execSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const tag = `v${pkg.version}`;

// Reject if `gh` is missing rather than silently failing later.
try {
  execSync("gh --version", { stdio: "ignore" });
} catch {
  console.error("gh CLI not found. Install from https://cli.github.com and re-run.");
  process.exit(1);
}

// Reject if the tag isn't pushed yet — release:patch should have done it.
try {
  execSync(`git ls-remote --tags origin ${tag}`, { stdio: "pipe" });
} catch {
  // ls-remote returns success even if the tag is missing; the real check
  // is whether the output contained the tag. Re-run capturing stdout.
}
const remoteTags = execSync("git ls-remote --tags origin", { encoding: "utf8" });
if (!remoteTags.includes(`refs/tags/${tag}`)) {
  console.error(
    `Tag ${tag} not on origin. Run npm run release:patch / :minor / :major first.`,
  );
  process.exit(1);
}

// If a release already exists for this tag, bail out instead of duplicating.
const exists = spawnSync("gh", ["release", "view", tag], { stdio: "ignore" });
if (exists.status === 0) {
  console.error(`Release ${tag} already exists on GitHub. Edit it with: gh release edit ${tag}`);
  process.exit(1);
}

const template = `### Bug Fixes
-

### Features
-

### Docs
-

### Breaking Changes
-
`;

const tmp = mkdtempSync(join(tmpdir(), "stream-relay-release-"));
const notesFile = join(tmp, "NOTES.md");
writeFileSync(notesFile, template);

const editor = process.env.EDITOR ?? "vi";
const editResult = spawnSync(editor, [notesFile], { stdio: "inherit" });
if (editResult.status !== 0) {
  console.error("Editor exited non-zero, aborting release.");
  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}

const notes = readFileSync(notesFile, "utf8")
  // Strip empty sections so the published notes don't carry placeholder bullets.
  .split(/\n(?=### )/)
  .filter((section) => {
    const lines = section.split("\n").slice(1);
    return lines.some((l) => l.trim() && l.trim() !== "-");
  })
  .join("\n")
  .trim();

if (!notes) {
  console.error("No release notes written, aborting.");
  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}

const publishResult = spawnSync(
  "gh",
  ["release", "create", tag, "--title", tag, "--latest", "--notes", notes],
  { stdio: "inherit" },
);

rmSync(tmp, { recursive: true, force: true });

if (publishResult.status !== 0) {
  console.error("gh release create failed.");
  process.exit(publishResult.status ?? 1);
}

console.log(`\nReleased ${tag} on GitHub.`);
