# Workflow Learnings

Environment blockers and their fixes, recorded by the planner or orchestrator for the role that hit them. The full contract — when to read, when to write, entry shape, deduplication — is in [MOBILE_WORKFLOW.md](MOBILE_WORKFLOW.md).

## Planner

### Role agents apply the mobile-simulator setup to browser-extension runs

- Symptom: dispatched for work whose product surface is `apps/extension` (the browser extension), a role agent starts by reading `apps/mobile/e2e/AGENTS.md`, claiming an iOS simulator, acquiring an `e2e-slot`, or trying to start Metro and the backend — none of which the extension needs. Steps are burned before any real work, and a device claim can block another run.
- Cause: the four role definitions in `.kilo/agent/` hard-code the mobile device workflow (`mobile-e2e-verifier` in particular instructs `pnpm dev:mobile:simulator claim` and Maestro). This workflow governs "mobile the product", which includes the extension, but the role text assumes a simulator.
- Fix: open every handoff for an extension run with an explicit scope-override block: product is `apps/extension` (WXT + React, Chrome MV3 + Firefox MV3); do NOT read `apps/mobile/e2e/AGENTS.md`; do NOT claim a device, run `e2e-slot.sh`, Maestro, `login.sh`, Metro, or any backend service; DO read `apps/extension/AGENTS.md`. Give the gate explicitly: `pnpm --filter kilo-extension verify | build | build:firefox | e2e:chrome | e2e:firefox`, plus `pnpm format` from the repo root. E2E is Playwright against a locally built extension using `apps/extension/tests/e2e/extension-context-fixture.ts` (`launchExtensionContext`, `seedExtensionAuth`, `setExtensionStorage`) and `kilo-api-fixture.ts`. Only the live-backend round (`pnpm --filter kilo-extension e2e:local`, `tests/e2e/local-backend-live.test.ts`) needs the shared local stack on `http://localhost:3000` — that round is the only one that warrants an `e2e-slot`.
- Verified 2026-07-27: with this override the repro-gate verifier reproduced five extension defects in one pass without touching a simulator.

### The documented orchestrator launch fails if its output is piped

- Symptom: the `tmux new-window … kilo run … --interactive …` launch exits immediately with `Error: --interactive requires a TTY stdout` and `EXITCODE=0`, so the window dies and nothing runs.
- Cause: wrapping the command in a launcher that pipes kilo through `tee`/`>` (a useful pattern for non-interactive role agents, where the log file is the authoritative progress signal) removes the TTY that `--interactive` requires.
- Fix: for the `--interactive` orchestrator, run `kilo` directly in the tmux pane with no pipe or redirection (`exec kilo run …` inside the launcher script is fine), and monitor it with `tmux capture-pane -p -t <session>:<window>` instead of a log tail. Keep the pipe-and-log pattern for the non-interactive role agents, where it works and is more reliable than pane scraping.

### The `--interactive` orchestrator wedges early; run it headless under a supervisor

- Symptom: an orchestrator launched exactly as the workflow documents (`kilo run … --interactive`) stops making progress a few minutes in. Signature: the pane's elapsed timer freezes at a fixed value (e.g. `▣ Build · … · 3m 5s` unchanged across repeated captures), token/cost counters stop moving, the process stays alive at ~0.5% CPU, and it cannot be interrupted. Distinguish a real wedge from a long thinking block by double-capturing the pane a few seconds apart: a working session's elapsed timer advances, a wedged one's does not.
- Cause: provider stream stalls in long autonomous runs. `--interactive` cannot recover from them and cannot be driven back to life from outside.
- Fix: kill the window and relaunch **headless** (`--auto`, no `--interactive`) under a bash supervisor loop in tmux that relaunches the same handoff on every exit with exponential backoff (30 → 300s), and stops on `gh pr view --json state,mergeable` reporting `OPEN MERGEABLE` (or merged), on N consecutive attempts with no new commits, or at an attempt cap. Headless exits cleanly on a stall, so relaunching works; write per-attempt logs plus one concise status log the planner can monitor. Two handoff changes are required for this to be safe: tell the orchestrator it will be relaunched and must self-assess real git state on every start (never trust a progress narrative, never redo a committed slice, front-load the smallest green commit), and tell it **not** to delete the handoff file — a relaunch needs it, so the planner deletes it at the end instead.

### Extension E2E: the kilo gateway fixture rejects safe-mode tool lists

- Symptom: a Playwright spec driving a fresh conversation fails inside `tests/e2e/kilo-api-fixture.ts` on a tool-list assertion, even though the UI behaved correctly.
- Cause: the fixture's default expected tool list includes `eval`, but a fresh conversation defaults to safe mode, which sends read-only tools only.
- Fix: pass the safe-mode tool names to the fixture (`toolNames: safeToolNames`) when the spec does not switch the conversation to dangerous mode.

## Orchestrator

### Extension E2E: analytics specs need VITE_POSTHOG_API_KEY at build time

- Symptom: every analytics e2e spec fails waiting on posthog identify/capture events after `pnpm --filter kilo-extension build`, even with `VITE_POSTHOG_API_KEY=e2e-test-key` on the playwright invocation.
- Cause: the key is inlined at build time; without it the build logs "VITE_POSTHOG_API_KEY is not set; extension analytics will be disabled in this build" and analytics is compiled out.
- Fix: set the key on the build — `VITE_POSTHOG_API_KEY=e2e-test-key pnpm --filter kilo-extension build` — before running targeted playwright specs. The `e2e:chrome` script already does this; only manual targeted runs forget it. Verified 2026-07-27.

### Nested `kilo run` fails with "Session not found" inside a harness worker

- Symptom: `kilo run` dispatched from inside a running Kilo harness session exits immediately with "Session not found".
- Cause: harness identity env vars (`KILO_RUN_ID`, `KILO_SERVER_PASSWORD`, `KILO_PROCESS_ROLE`, `KILO_PID`, `KILO`, `KILOCODE_FEATURE`, `KILOCODE_VERSION`) leak into the nested CLI, which tries to attach to the parent session.
- Fix: dispatch role agents with the identity vars stripped, e.g. `env -u KILO_RUN_ID -u KILO_SERVER_PASSWORD -u KILO_PROCESS_ROLE -u KILO_PID -u KILO -u KILOCODE_FEATURE -u KILOCODE_VERSION kilo run ...`. Verified 2026-07-27 across every role-agent dispatch of the extension side-panel run.

### Pass role-agent handoffs with `--file`, never shell substitution

- Symptom: a handoff embedded via `"$(cat file)"` corrupts the prompt — markdown backticks inside double quotes are still executed by the shell.
- Fix: write the handoff to a temp file outside every repository and attach it with `--file <path>` (repeatable). Put the short positional message BEFORE the flags: `--file` accepts multiple values and would consume a trailing message as another file path, failing with "File not found".

### Firefox Selenium e2e: `UnsupportedOperationError: newSession` under machine load

- Symptom: `e2e:firefox` dies mid-run with `UnsupportedOperationError: newSession` after a varying number of passing scenarios (17, then 9), never on a product assertion.
- Cause: geckodriver cannot spawn the next per-scenario Firefox instance while the machine is under heavy load (several parallel agent runs; load average >10). Sessions are created and quit per scenario, so the failure point moves with system pressure.
- Fix: retry the command; do not patch product code or the harness for this. A green full run (33/33) followed on the third attempt once load dipped. Verified 2026-07-27.
