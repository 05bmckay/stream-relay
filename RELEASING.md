# Releasing stream-relay

All releases publish from the repo root as a single npm package with subpath
exports (`stream-relay/client`, `stream-relay/server`, `stream-relay/worker`,
`stream-relay/hono`).

## Quick release

A full release is two commands. The first ships to npm; the second creates the GitHub release. Both are required.

```bash
npm run release:patch    # bug fix:      0.1.2 -> 0.1.3
npm run release:minor    # new feature:  0.1.2 -> 0.2.0
npm run release:major    # breaking:     0.1.2 -> 1.0.0

npm run release:github   # opens $EDITOR for release notes, creates the GitHub release
```

The `release:<kind>` script handles npm:

1. `npm version <kind>` bumps `package.json`, creates a version commit and a git tag.
2. `npm publish` runs `prepublishOnly` (which runs `tsup`), then publishes to the npm registry.
3. `git push origin main --tags` pushes the version commit and the tag to GitHub.

The `release:github` script reads the version from `package.json`, runs `gh release create`, and drops you into your editor for the release notes. **A release is not done until both have run** — dependents check the npm registry, but humans look at GitHub releases for the changelog.

## Step-by-step

### 1. Commit your changes

```bash
git add <files>
git commit -m "fix: description"
```

Use conventional-ish prefixes (`fix:`, `feat:`, `docs:`, `breaking:`) to keep the log scannable. Nothing enforces this; it's just for the humans reading later.

### 2. Sanity-check the build before bumping

```bash
npm run typecheck
npm run build
npm pack --dry-run
```

The dry-run tarball should contain only `dist/` and `README.md`. If anything else shows up, fix the `files` field in `package.json` before publishing.

### 3. Bump and publish

```bash
npm run release:patch    # or :minor / :major
```

### 4. Create the GitHub release

After the npm publish completes, run:

```bash
npm run release:github
```

This opens your editor with a release-notes template, then creates the release on GitHub against the tag the previous step pushed. Use the headers `### Bug Fixes`, `### Features`, `### Docs`, and `### Breaking Changes` as applicable. Prefix each item with the affected entry point in bold (`**client:**`, `**server:**`, `**worker:**`, `**hono:**`).

If you'd rather pass notes inline:

```bash
gh release create v0.1.3 --title "v0.1.3" --latest --notes "$(cat <<'EOF'
### Bug Fixes
- **client:** description of fix

### Features
- **worker:** description of feature
EOF
)"
```

## If the push fails

`release:*` runs `npm version`, `npm publish`, and `git push` in sequence. If publish succeeds but push fails (most often because the remote moved while you were releasing):

```bash
git pull --rebase origin main
git push origin main --tags
```

The npm release is already live, so don't try to re-publish; just get the tag pushed.

## If the publish fails

If `npm publish` fails after `npm version` already created a commit and tag, undo the local-only state before retrying:

```bash
git reset --hard HEAD~1                   # drop the version commit
git tag -d v$(node -p "require('./package.json').version")   # drop the tag
```

Then fix whatever broke and run the release again.

## Pre-1.0 conventions

While the package is < 1.0, treat `0.x.0` bumps as if they were major: the wire protocol and hook surface can change. Once we tag 1.0, switch to strict semver (`patch` for fixes, `minor` for additive, `major` for breaking).
