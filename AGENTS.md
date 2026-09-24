# Development Rules

## Conversational Style

- Keep answers short and concise
- No emojis in issues, PR comments, or code
- No fluff or cheerful filler text (e.g., "Thanks @user" not "Thanks so much @user!")
- Technical prose only, be direct
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check `node_modules` for external API types (`@earendil-works/pi-*`, `typebox`, etc.); don't guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Match the surrounding code style — it is enforced by biome (`biome.json`).
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
- This is a pi extension. Respect the Claude Code-compatible tool names, calling conventions, and UI patterns the extension deliberately mirrors; don't diverge from them without a stated reason.
- When reviewing a diff, favor solutions that are elegant, not overengineered — flag needless abstraction, layering, or defensive code that the change doesn't warrant.

## Commands

- After code changes (not docs), run the full check suite and fix all errors and warnings:
  ```bash
  npm run lint        # biome
  npm run typecheck   # tsc --noEmit
  npm run test        # vitest run
  ```
- `npm run lint:fix` auto-fixes most style issues.
- `npm run test` runs the whole suite. To iterate on a single file, run it directly: `npx vitest run test/<file>.test.ts`.
- `npm run test` includes `test/subagents-e2e.test.ts`, which runs pi-tasks with the real `@tintinweb/pi-subagents`. It loads pi-subagents from `PI_SUBAGENTS_DIR`, or from a `pi-subagents` checkout next to this repository, and skips itself when neither exists (CI). The checkout needs its own `npm install`, and a pi-subagents change in progress there is what the suite tests.
- If you create or modify a test file, run it and iterate on the test or implementation until it passes.
- `npm run build` compiles with `tsc`; run it only when verifying the build output or when requested.
- For ad-hoc scripts, write them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in `bash` commands.

## Pi Compatibility

`package.json` is the only place that states a Pi version. Do not write a Pi or `typebox`
version into docs, comments, scripts or CI; refer to `package.json` instead. `CHANGELOG.md`
is exempt, because its entries record history.

- `peerDependencies` names the floor: every `@earendil-works/pi-*` peer is `>=X.Y.Z`, with one
  floor for all of them.
- `devDependencies` pins every `@earendil-works/pi-*` package at one exact version, the version
  the code is developed against. The pin is at or above the floor, and it includes every peer.
- `devDependencies.typebox` pins exactly the `typebox` that the pinned
  `@earendil-works/pi-coding-agent` depends on. Pi hands its own copy to extensions, so the
  types must come from the same release.
- `devDependencies` pins `@earendil-works/pi-ai` for the integration tests only. Their faux
  model (`test/helpers/pi-host.ts`) reads the host's message shapes, so it must come from the
  pinned Pi release. The extension does not import it, so it is not a peer.

`test/pi-versions.test.ts` fails when these rules break, when `package-lock.json` disagrees
with `package.json`, or when CI, the install script or this section hard-codes a version.

`.github/scripts/install-pi.sh` is the one way to install a Pi version. It installs every
`@earendil-works/pi-*` package in `devDependencies` at that version, plus the matching `typebox`.

- To move the pin: `bash .github/scripts/install-pi.sh X.Y.Z --save`, then run the full check suite.
- To move the floor: edit every `@earendil-works/pi-*` entry in `peerDependencies`. CI follows.

CI checks both ends of the range (`.github/workflows/ci.yml`):

- `compat-floor-pi` runs `install-pi.sh floor`, which reads the floor from `peerDependencies`,
  then typecheck + tests. It is not `continue-on-error`: a green run is the only evidence behind
  the range. If the floor can no longer be supported, raise `peerDependencies` rather than
  weakening the job.
- `compat-latest-pi` runs `install-pi.sh latest`, so upstream breakage surfaces before it
  reaches users. It is `continue-on-error`: current Pi is not a hard guarantee.

To reproduce a compat job locally, run the script with `floor` or `latest`, run the checks,
then `npm ci` to restore the pinned install.

## Git

- **Never commit.** The user commits manually. At most, suggest a concise commit message as text.
- **Never push**, tag, or create branches unless the user explicitly asks.
- Never run history- or worktree-destroying commands: `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`, or any force push.
- Leave the working tree as the user left it — don't stage, stash, or revert files you didn't change.

## Issues and PRs

See `CONTRIBUTING.md` for the contributor guidelines and quality bar.

When reviewing PRs:

- Do not run `gh pr checkout`, `git switch`, or otherwise move the worktree to the PR branch unless the user explicitly asks.
- Use `gh pr view`, `gh pr diff`, `gh api`, and local `git show`/`git diff` against fetched refs to inspect PR metadata, commits, and patches without changing branches.
- If you need PR file contents, fetch/read them into temporary files or use `git show <ref>:<path>` without switching branches.

When posting issue/PR comments:

- Write the comment to a temp file and post with `gh issue/pr comment --body-file` (never multi-line markdown via `--body`).
- Keep comments concise, technical, and in the user's tone.

## Changelog

Location: `CHANGELOG.md` (single file, [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) format).

- All new entries go under `## [Unreleased]`, in the right subsection (`### Added`, `### Changed`, `### Fixed`, `### Removed`, `### Security`, `### Refactored`). Read the section first and append to existing subsections; never duplicate them.
- One bullet per issue/PR. Never combine separate issues or pull requests into a single entry, even when they touch the same or similar components. (A PR together with the issue it closes or that diagnosed it is one change — one bullet citing both.)
- Breaking changes are not a separate subsection. Call them out with a `> **⚠️ Breaking: …**` blockquote at the top of the version section, and/or a bold `**BREAKING:**` bullet under `### Changed`, with a migration note.
- Entries are concise — a bold lead-in stating what changed, then a sentence or two on why it changed and anything a user must do about it. Aim for 2–4 sentences; a genuinely intricate change may run longer, but length is never the goal. Do not match the density of older entries, several of which are far too long.
- Cut what the reader doesn't need: narration of the investigation, alternatives considered and rejected, restatements of the diff, and detail recoverable from the code or the linked issue. Name a file or symbol only when it helps someone find the change.
- Released version sections (e.g. `## [0.7.0]`) are immutable; never modify them.
- Attribute external contributions: `... ([#456](https://github.com/tintinweb/pi-tasks/pull/456) — thanks [@username](https://github.com/username))`.

## Releasing

**Versioning** (all releases are `0.x`, no major bumps):

- `minor` (`0.x.0`) — a notable new feature, or any breaking change.
- `patch` (`0.x.y`) — bug fixes and smaller additions.

Before a release:

- Update `CHANGELOG.md` — move the `## [Unreleased]` entries under a new `## [X.Y.Z]` version section, and add a fresh empty `## [Unreleased]` for the next cycle.
- Update `README.md` if user-facing behavior changed (features list, settings, usage).
- Run the full check suite and fix anything that fails:
  ```bash
  npm run lint
  npm run typecheck
  npm run test
  npm run build
  ```
  (`prepublishOnly` runs lint + typecheck + test + build.)

**Never publish.** The user runs `npm version` / `npm publish` and any tagging manually. Do not run those commands unless the user explicitly asks.

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.
