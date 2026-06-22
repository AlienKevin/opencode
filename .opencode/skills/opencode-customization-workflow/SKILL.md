---
name: opencode-customization-workflow
description: Use when changing opencode itself, especially TUI customization, HMR, fork maintenance, CI-grade verification, commits, pushes, PRs, or safe rollback planning.
---

# opencode Customization Workflow

Use this skill when the task changes this opencode checkout rather than a user's separate application. It covers the local fork workflow, TUI HMR, thorough verification before presenting results, commit/push hygiene, and rollback safety.

## First Rules

- Inspect the codebase before assuming where behavior lives.
- Preserve unrelated user or agent changes in the worktree.
- Do not commit, amend, push, force-push, stash, reset, or open a PR unless the user explicitly asks.
- Run commands from package directories for local verification. Never run tests from the repo root; root `test` intentionally fails.
- Use `bun typecheck` from package directories, not `tsc` directly.
- Prefer the smallest correct code change and verify the exact behavior the user reported.
- When a UI change is visible, verify it manually or explain why manual verification was not possible.

## Repo And Fork Checks

Before substantial work or before any commit/push request, inspect:

```sh
git status --short
git branch --show-current
git remote -v
git log --oneline -10
```

Important repo conventions:

- Default upstream branch is `dev`; local `main` may not exist.
- Branch names are short, at most three words, hyphen-separated, no slashes and no type prefix.
- Commit messages and PR titles use conventional style, for example `fix(tui): keep prompt border in build mode`.
- This checkout may track the fork remote `fork` (`AlienKevin/opencode`) while `origin` is upstream (`anomalyco/opencode`). Confirm before pushing.

## TUI HMR

The current TUI HMR system is in `packages/tui/src/hmr.tsx` and is wired in `packages/tui/src/app.tsx`.

Key files:

- `packages/tui/src/app.tsx`: stable runtime shell. It creates the renderer, keymap, providers, SDK/plugin runtime, and starts HMR.
- `packages/tui/src/app-view.tsx`: hot UI boundary exported as `AppView`.
- `packages/tui/src/hmr.tsx`: `hotComponent`, HMR registry, watcher, module graph copier, relative import rewriter, and fallback behavior.
- `packages/tui/test/hmr.test.tsx`: automated HMR coverage.

How it works:

- `app.tsx` defines `hmrRoots = [{ id: "app-view.tsx#AppView", file: "app-view.tsx", exportName: "AppView" }]`.
- `HotAppView = hotComponent(..., AppView)` renders the registered component signal.
- `startHmrWatcher({ srcDir: import.meta.dir, roots: hmrRoots })` watches `packages/tui/src`.
- The watcher reacts to `.ts`, `.tsx`, `.js`, `.jsx`, and `.json` changes and ignores `.opencode-hmr-*` folders.
- Reload builds a temporary module graph under `packages/tui/src/.opencode-hmr-*`, rewrites relative imports to that graph, imports the root, and swaps the registered component only after a successful import.
- If reload fails, it logs the error and keeps the previous working UI.
- HMR debug logs go to `/tmp/opencode-hmr.log`.
- Stable modules are deliberately not copied, so provider/context/keymap/runtime state stays live. Stable roots include `config/`, `context/`, `plugin/`, `runtime.tsx`, `keymap.tsx`, `hmr.tsx`, `app.tsx`, `ui/dialog.tsx`, `ui/toast.tsx`, and prompt state modules.

Manual HMR test:

```sh
cd /Users/kevin/Dev/opencode/packages/opencode
tmux new-session -d -s opencode-hmr 'bun dev'
tmux capture-pane -pt opencode-hmr
```

Then edit a visible UI string under the `AppView` graph, such as `packages/tui/src/component/prompt/index.tsx`, and check that the running TUI updates without a restart.

Inspect HMR logs:

```sh
tail -f /tmp/opencode-hmr.log
```

Expected successful log shape:

```txt
change detected: ...
reloading hot roots
reload succeeded: app-view.tsx#AppView
```

Fallback test: temporarily introduce a syntax error in a hot UI file. The TUI should keep the old UI and log `reload failed`. Fix the error and confirm reload succeeds.

Stop the manual TUI when done:

```sh
tmux kill-session -t opencode-hmr
```

If HMR leaves `packages/tui/src/.opencode-hmr-*` directories after a crash, inspect them first. Remove only those generated temp folders and never delete unrelated files.

## Verification Workflow

Use a layered verification sequence. Do not present completion to the user until the relevant sequence has passed or you can clearly explain a blocker.

1. Reproduce or observe the issue when feasible.
2. Run a focused test for the touched behavior.
3. Run the package typecheck.
4. Run the package test script when the touched package has meaningful tests.
5. Run broader CI-parity commands only when the scope justifies the cost.
6. Manually verify visible TUI behavior for UI changes.
7. Inspect `git diff` and `git status --short` before summarizing.

For TUI changes:

```sh
cd /Users/kevin/Dev/opencode/packages/tui
bun typecheck
bun test test/hmr.test.tsx --timeout 30000
bun run test
```

For focused TUI tests, prefer the exact test file first:

```sh
cd /Users/kevin/Dev/opencode/packages/tui
bun test test/<area>.test.tsx --timeout 30000
```

For core CLI/server changes:

```sh
cd /Users/kevin/Dev/opencode/packages/opencode
bun typecheck
bun test test/<area>/<file>.test.ts --timeout 30000
bun run test
```

Run HTTP API gates when HTTP API, server routes, OpenAPI, or SDK generation behavior changed:

```sh
cd /Users/kevin/Dev/opencode/packages/opencode
bun run test:httpapi
```

If API or SDK surfaces changed, regenerate the JavaScript SDK from repo root:

```sh
./packages/sdk/js/script/build.ts
```

CI reference:

- `.github/workflows/typecheck.yml` runs root `bun typecheck` through Turbo.
- `.github/workflows/test.yml` runs `bun turbo test --output-logs=errors-only --log-order=grouped --log-prefix=task` on Linux and Windows.
- The same workflow runs `bun run test:httpapi` from `packages/opencode` on Linux.
- App e2e CI runs `bun --cwd packages/app test:e2e:local` after installing Chromium.

Local agent workflow should still respect package-directory test/typecheck rules unless the user explicitly asks for CI-parity root commands.

## Thoroughness Pattern From Session `ses_1147f7cedffe5ybXwIxUQHWpvo`

The referenced HMR session is a good model for how to validate before reporting success:

- It searched for the existing TUI HMR and CI/test surfaces before editing.
- It added focused HMR tests for nested dependency reloads, stable context preservation, and failed-reload fallback.
- A focused HMR run exposed a real design issue: temp modules outside the package could not resolve the JSX runtime.
- The implementation changed temp graph placement to `packages/tui/src/.opencode-hmr-*` and reran the focused HMR tests.
- It ran `bun typecheck` before broader tests.
- The full TUI suite exposed an unrelated-but-real provider fixture mismatch; the fixture was fixed rather than ignored.
- It reran affected sync tests, typecheck, focused HMR tests, and the full TUI suite.
- It checked final status/diff and verified no HMR temp directories remained.
- Only after that did it summarize: typecheck passed, focused HMR passed, affected sync tests passed, full TUI tests passed with known harmless warnings.

Adopt that pattern: focused test, typecheck, broader test, investigate failures, rerun affected tests, rerun broad tests, inspect cleanup, then report.

## Presenting To The User

Report only after verification is complete.

Include:

- What changed, with file paths.
- What verification ran and whether it passed.
- Any warnings, skipped tests, or known unrelated failures.
- Whether a running TUI must be restarted once to pick up runtime/HMR wiring changes.
- A note about unrelated dirty worktree files if present.

For UI changes, mention the manual check or the exact reason it was not performed.

## Commit And Push Workflow

Only commit or push when explicitly requested.

Before committing:

```sh
git status --short
git diff
git log --oneline -10
```

Then:

- Stage only intended files.
- Never stage secrets, local logs, `.opencode-hmr-*`, build artifacts, or unrelated user changes.
- Use a conventional commit message matching repo style.
- Do not amend unless the user explicitly asks.
- Do not skip hooks unless the user explicitly asks and accepts the risk.

Commit example:

```sh
git add <intended-files>
git commit -m "fix(tui): keep prompt mode in build"
```

Before pushing:

```sh
git branch --show-current
git remote -v
git status --short
git log --oneline -10
```

Push to the correct remote and branch, usually the current fork branch when this checkout tracks `fork/*`:

```sh
git push -u fork <branch>
```

Use `gh` for GitHub PRs and checks. Before opening a PR, inspect the diff from the base branch, review all commits included, and fill the PR template with a concise description and verification commands. Upstream PRs should usually target `dev` and reference an issue.

## Rollback And Safety

Prefer reversible actions.

Before risky changes, record:

```sh
git branch --show-current
git rev-parse --short HEAD
git status --short
```

Safe checkpoints:

- Create a temporary branch at the known-good commit when the user wants a safety point: `git branch backup-<short-name> HEAD`.
- Keep changes small and commit after a verified unit of work when the user wants a durable checkpoint.
- Use PR branches for experiments instead of working directly on `dev`.

If changes are problematic before commit:

- Do not run `git reset --hard` or broad `git checkout --`.
- Inspect `git diff` and selectively reverse only the assistant-owned hunks with `apply_patch`.
- If user changes are mixed into the same file, ask before touching ambiguous hunks.

If a committed local change is problematic:

- Prefer `git revert <commit>` for shared or pushed commits.
- For local-only commits, ask before using history-rewriting commands.
- If the user explicitly asks to go back while preserving changes, use `git reset --soft <target>` or a new branch, not a hard reset.

If a pushed change is problematic:

- Prefer `git revert <commit>` and push the revert.
- Avoid force-push unless the user explicitly asks, confirms the target remote/branch, and accepts coordination risk.

If the app cannot start because of config/plugin/skill changes:

- Use `OPENCODE_DISABLE_PROJECT_CONFIG=1` to start without project config.
- Use `OPENCODE_PURE=1` or `OPENCODE_DISABLE_DEFAULT_PLUGINS=1` to isolate plugin issues.
- Use `OPENCODE_DISABLE_EXTERNAL_SKILLS=1` to isolate external skill loading.

## Final Checklist

- Relevant focused tests passed.
- Relevant package typecheck passed.
- Broader package tests or CI-parity commands passed, or blockers are documented.
- Manual TUI/HMR behavior was checked for UI changes.
- No generated HMR temp folders, logs, secrets, or unrelated files are staged.
- Final response includes changed files, verification, and any residual risk.
