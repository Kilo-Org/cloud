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

### Role-agent round exits 0 with no verdict (kilo stream stall)

Symptom: a dispatched role agent's `kilo run` exits with `EXITCODE=0` after some tool calls, but
the log ends mid-sentence with no findings list and no `No findings.` A bare exit code reads as
success, so the round silently counts as a pass.

Cause: kilo/grok stream stall — the CLI ends the session without emitting the final assistant
message. Unrelated to the agent definition or to permission denials.

Fix: treat "exit 0 without the required verdict string" as a void round, discard it, and
re-dispatch a fresh session. Detect it by grepping the log for the verdict, never by exit code
alone. Monitor the log for byte-size stagnation as well as for process exit, so a stall is
distinguishable from work in progress.

### Reviewer wastes steps on auto-rejected `.env` reads

Symptom: a reviewer logs `permission requested: read (apps/mobile/.env); auto-rejecting` and burns
steps retrying env files it can never read.

Cause: the role definitions' secrets rule correctly blocks `.env` reads, but a handoff that cites
`.env` facts invites the attempt.

Fix: state every sanitized env value inline in the handoff and tell the agent explicitly that it
is not permitted to read `.env` / `.env.local.example` and should treat the handoff table as
authoritative.

### `kilo run --interactive` dies when stdout is piped

Symptom: launching the orchestrator as `kilo run ... --interactive ... | tee log` exits immediately
with `Error: --interactive requires a TTY stdout`.

Cause: piping stdout replaces the TTY that `--interactive` requires. Affects any attempt to tee an
interactive kilo session's output to a file.

Fix: launch the interactive session as the tmux window command with no pipe, then attach logging
separately with `tmux pipe-pane -t <session>:<window> -o "cat >> <logfile>"`. Read live state with
`tmux capture-pane -p -t <session>:<window>`. Non-interactive role-agent dispatches are unaffected and
can still be teed.

### Dispatching role agents from a non-kilo harness (tmux, exit codes, void rounds)

**Symptom.** A `kilo run --agent <role>` dispatched from a harness whose Bash tool has a 10-minute timeout gets killed mid-review. Worse, a run that is piped (`kilo run ... | tee log`) records the exit status of `tee`, not of kilo, so a crashed agent reports `EXITCODE=0` and reads as a clean pass.

**Cause.** Two independent traps: the harness command timeout, and `$?` after a pipeline referring to the last stage.

**Fix.** Run the agent inside a tmux window from a small wrapper script, redirect rather than pipe, and append the exit code of the redirected command:

```bash
cd "$WORKTREE/apps/mobile"   # .kilo/agent/ must be discoverable from the cwd
kilo run "$(cat msg.txt)" --model kilo/x-ai/grok-4.5 --variant high \
  --agent mobile-plan-reviewer --file "$PLAN" > "$LOG" 2>&1
echo "EXITCODE=$?" >> "$LOG"
```

Then wait event-driven with an `until grep -q EXITCODE= "$LOG"` loop that also breaks when the tmux session disappears. Keep the message positional **before** the flags: `--file` takes multiple values and swallows a trailing message as a path.

### A kilo role agent can exit mid-run with no verdict — treat it as a void round

**Symptom.** The agent's log ends on an ordinary progress line ("Checking how decider scores are assigned…"), the tmux window is gone, and no findings list was ever printed. With a piped exit code this is indistinguishable from a pass.

**Cause.** Long kilo runs die on provider stream stalls, typically 10–15 minutes in. Nothing about the plan or the repository is wrong.

**Fix.** A round that produced no explicit verdict line is **void, never a pass**. Re-dispatch a fresh agent — the review gate wants a fresh session per round anyway, so nothing is lost. Detect it by requiring the verdict text itself (`No findings.` or a numbered list), not by exit code. If several consecutive rounds die at the same point, shrink the handoff rather than retrying unchanged.

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

### PR-review E2E env traps (stub token path)

- **Symptom:** `githubApps.devSeedUserGithubToken` fails or the app shows
  `GitHub connection expired` even after seeding; the GitHub stub never logs
  a request.
- **Cause:** (1) worktree `.env.local` missing the `USER_GITHUB_APP_TOKEN_*`
  encryption keys, so the seeded token cannot be encrypted/decrypted; (2)
  `services/git-token-service/.dev.vars` has empty token keys, so the token
  endpoint returns 503.
- **Fix:** copy the missing `USER_GITHUB_APP_TOKEN_*` key lines from the
  primary checkout's `.env.local` (temporary, strip after the run), fill the
  empty keys in `services/git-token-service/.dev.vars`, restart
  git-token-service + nextjs, re-seed, then reopen the PR in the app (a
  "Check connection" retry alone may not refetch after the first 412s).
- **Also:** iOS shows an `Allow Paste` prompt before the PR-URL paste lands;
  and the Safari `Open this page in "Kilo"?` wording can differ from the
  settle-app regex — tap the exact `Open` accessibility action instead.
### iOS 26.5 scheme-confirmation prompt wording breaks login.sh on a fresh install

- Symptom: on a freshly installed dev client, `apps/mobile/e2e/login.sh` fails its settle assertion with the simulator stuck on the home screen under a SpringBoard dialog `Open in "Kilo"?` (Cancel/Open).
- Cause: iOS 26.5 reworded the custom-scheme confirmation from `Open this page in "Kilo"?` to `Open in "Kilo"?`. The matchers in `e2e/flows/open-app.yaml` and `e2e/flows/settle-app.yaml` only know the old text, so the bounded optional-prompt tap never fires. The dialog appears exactly once per install (first external open of the `exp+kilo-app` scheme); iOS does not re-prompt afterwards.
- Fix: tap `Open` once yourself (a two-line temp Maestro flow with `appId: host.springboard` and `tapOn: { text: 'Open', optional: true }`, or any equivalent), then re-run `login.sh` — it is idempotent and completes. Do not reinstall afterwards: a reinstall re-arms the one-time prompt. If the flows are ever updated, add `Open in "Kilo"\?` as an alternative in the same regexes rather than replacing the old text, so older iOS versions keep working.

### Role-agent kilo run dies silently when the session payload exceeds the pruning limit

- Symptom: a dispatched `kilo run` role agent (observed: mobile-e2e-verifier) exits mid-task with no error and no final report; its transcript just stops, often right after a large tool output.
- Cause: the agent's session payload grows past the pruning limit (`opencode.log` shows `payload still large after pruning ... size=3042931` at the kill time) and the harness terminates the run. E2E agents inflate the payload fast: full `maestro hierarchy` dumps (~80 KB), full `pnpm dev:capture mobile` panes with the QR art, repeated echo of the same long command output, screenshots read into context.
- Fix: steer the redispatch with an explicit output-discipline constraint: every shell command ends in a hard cap (`| tail -c 1500` / `| tail -5`), hierarchies and captures go to files and only greps/counts are printed, screenshots are not re-read into context, docs are inlined in the handoff instead of re-read, and the final report has a line cap. A round-3 dispatch with these rules survives long enough to finish; rounds 1-2 without them died at ~4-10 minutes.

### Deterministic cloud-agent turns via fake-llm (real-provider turns stall E2E)

- Symptom: the E2E verifier starts an app-driven cloud-agent session and the turn never completes: "Considering next steps" for 9+ minutes, or `terminal-failed`, while real-provider routing burns credits and time. Round after round cannot score the turn-based acceptance criteria.
- Cause: `KILO_OPENROUTER_BASE` in `services/cloud-agent-next/.dev.vars` points at nextjs (`http://localhost:<nextjs-port>/api`), i.e. real model providers — non-deterministic and slow in dev. Three environment traps compound it: (1) `e2e/login.sh` signs out first, so a verifier that "re-runs login" mid-task strands the app on the login screen (never let it); (2) a hermetic `platform_integrations` row with a made-up repo (e.g. `kilo-stub/...`) passes the composer repo picker but fails dispatch with `GitHub token or active app installation required` — the cached repo must belong to a real, locally mintable installation (e.g. `iscekic/getel`, installation `144771093`); (3) fake-llm stock only knows model `fake-deterministic`, so worker-side `models/validate` and the sandbox CLI's catalog lookup both reject the app's `kilo-auto/*` selection (`model_missing`, classified `managed_model_configuration`).
- Fix: route the turn to fake-llm and re-apply this harness patch set (deliberately not committed — harness-local): set `KILO_OPENROUTER_BASE=http://localhost:<8811+portOffset>/api` in `services/cloud-agent-next/.dev.vars` and `pnpm dev:restart cloud-agent-next`; in `services/cloud-agent-next/test/e2e/fake-llm-server.ts` accept `kilo-auto/*` + `kilo/*` in `handleModelValidation` AND add catalog entries for `kilo-auto/frontier|balanced|efficient` (clone `FAKE_MODEL`, non-zero pricing e.g. `0.000003`/`0.000015` so cost computes non-zero); `pnpm dev:restart fake-llm`. Prompt `__fake__:echo:<text>` in the composer — the assistant replies `<text>` with usage, the session auto-titles `<text>`, and the title-model call is handled by design. A cloud turn then completes in ~30s with cost pill + model label visible. Revert the patch, restore `.dev.vars`, and delete the fixture rows when done.

### Waiting on the EXITCODE marker false-triggers mid-run

**Symptom.** An `until grep -q EXITCODE= "$LOG"` wait loop (Planner section, first entry) reports the role agent finished while it is still running: the string `EXITCODE=` already appears in the log because the agent read `WORKFLOW_LEARNINGS.md` or a handoff that documents the pattern, and the TUI echoes it into the capture.

**Cause.** The wait pattern greps for a marker that is no longer unique to the wrapper's final append.

**Fix.** Treat the run as done only when the tmux session is gone **or** the marker is the last line of the log (`tail -1 "$LOG" | grep -q '^EXITCODE=[0-9]'`). The plain `grep -q EXITCODE=` form is only safe if neither the handoff nor anything the agent is likely to read mentions the pattern — which this file does, so prefer the last-line check.

### Reading Kilobot's no-findings state (post #4765)

**Symptom.** The completion gate wants "Kilobot has reviewed the latest head", but the review no longer arrives as inline threads: with the bot skip/permit config (#4765) on main, a clean review produces a green `Kilo Code Review` check plus exactly one issue comment from `kilo-code-bot[bot]` headed `Status: No Issues Found | Recommendation: Merge`.

**Fix.** That combination — green check on the current head, the no-issues summary comment, zero review threads (`gh api repos/.../pulls/<n>/comments` empty) — *is* the reviewed-with-no-findings state. There is nothing to reply to or resolve; the gate is met. A `BLOCKED`/`REVIEW_REQUIRED` merge state at that point only means the requested human review is pending.

### SpringBoard `Open in "Kilo"?` confirmation blocks `simctl openurl` (2026-07-27, PR #4697 main-merge)

- Symptom: `e2e/login.sh` fails at settle-app: after preflight's `xcrun simctl openurl` a SpringBoard dialog `Open in "Kilo"?` (curly quotes, Cancel/Open buttons) stays on screen; `settle-app.yaml` only matched the Safari wording `Open this page in "Kilo"?` and timed out.
- Cause: origin/main added `associatedDomains: ['applinks:app.kilo.ai']` (universal links) in `app.config.ts`; with the merged build installed, opening the custom scheme via `simctl openurl` surfaces a SpringBoard confirmation the flows did not handle.
- Fix: match both wordings in `e2e/flows/settle-app.yaml` and `e2e/flows/open-app.yaml` (`Open in ["“”]Kilo["“”]\?` alongside the Safari string) and tap `Open` in the same bounded optional-prompt slot; updated the stale "skips Safari's confirmation" bullet in `e2e/AGENTS.md`.

### Maestro `IOSDriverTimeoutException` under multi-simulator load (2026-07-27, PR #4697 verifier rerun)

- Symptom: every Maestro command against a claimed iOS simulator fails with `xcuitest.installer.LocalXCTestInstaller$IOSDriverTimeoutException: iOS driver not ready in time`, even with `MAESTRO_DRIVER_STARTUP_TIMEOUT=300000`; `simctl openurl` may also time out (`NSPOSIXErrorDomain code=60`).
- Cause: a stale `xcodebuild test-without-building` process left bound to the UDID after a killed Maestro run (check `ps aux | grep xcodebuild` and match the `-xctestrun` temp path / `id=<udid>`), compounded by several same-type simulators booted by sibling worktrees.
- Fix: kill only the `xcodebuild` process whose xctestrun path contains your UDID, then `xcrun simctl shutdown <udid> && xcrun simctl boot <udid>` (app and login state survive; `login.sh` is idempotent). Validate with a one-step `takeScreenshot` flow before dispatching the verifier again.

### "GitHub connection expired" against hermetic stub = git-token-service 503 (2026-07-27, PR #4697 C3)

- Symptom: PR-review E2E with the hermetic GitHub stub opens the PR then stalls on "GitHub connection expired / Check connection"; the stub request log shows only the first `pulls/<n>` fetch and no further traffic; nextjs logs repeated `githubPrReview.getPullRequest 412`.
- Cause: `withGitHubUserTokenRetry` resolves the user's GitHub token through git-token-service before any outbound call; the service's `POST /internal/github-user-authorizations/token` returned `503 authentication_unavailable` because its `NEXTAUTH_SECRET_DEV` Secrets Store binding had never been created in this worktree (Secrets Store state is local to each Worker directory). A missing-URL or key-drift `USER_GITHUB_APP_TOKEN_*` envelope produces the same 412 surface.
- Fix: `pnpm dev:env -y cloudflare-git-token-service` (creates `NEXTAUTH_SECRET_DEV` and syncs the `USER_GITHUB_APP_TOKEN_*` envelope into the worker env from root `.env.local`), then `pnpm dev:restart cloudflare-git-token-service`. Smoke with an authenticated `GET /api/trpc/githubPrReview.getPullRequest?...owner=kilo-stub...` — expect 200, not 412. Note nextjs reads `GIT_TOKEN_SERVICE_API_URL` from `apps/web/.env.development.local` (`@url cloudflare-git-token-service`), not from root `.env.local`.

### Hermetic GitHub stub lacks `GET /pulls/{n}/files` — Files-tab E2E 404s (2026-07-27, PR #4697 C3)

- Symptom: PR-review Files tab shows "Pull request unavailable" while Overview loads fine; nextjs logs `githubPrReview.listFiles 404`; stub request log shows every pinned endpoint hit except `/files`.
- Cause: the stub's pinned surface (REST pull/repo/check-runs/statuses + GraphQL review ops) does not cover `GET /repos/{owner}/{repo}/pulls/{n}/files`, which `listFiles` needs.
- Workaround (one-off): temporarily add a `/files` handler returning patched-file fixtures, restart the stub tmux session, verify, then restore `server.mjs` byte-identical. Permanent fix (teach the stub `/files` + pagination) is intentionally left out of scope; do it as a dedicated harness change when a run needs Files-tab E2E regularly.

### Worktree slug hashing to port offset 2000 collides with macOS AirPlay Receiver (5000/7000)

- Symptom: `pnpm dev:start` fails with `Refusing to share occupied worktree service ports: nextjs:5000` even with no other dev stack running; `lsof -iTCP:5000` shows `ControlCe` (macOS AirPlay Receiver), which also holds 7000.
- Cause: `computePortOffset` derives the offset from the worktree slug hash; `expo-sdk57-upgrade` deterministically hashes to offset 2000, so nextjs lands on 3000+2000=5000. Any worktree whose slug buckets to 20 hits this permanently; only `dev:status` reads the offset back from the manifest, so `dev:start`/`dev:restart`/`dev:env` all recompute from the environment.
- Fix: prefix every port-computing dev command with an explicit collision-free offset, e.g. `KILO_PORT_OFFSET=2100 pnpm dev:start ...` (2100 clears AirPlay: nextjs 5100, metro 10181, wrangler 10889+). `dev:status`/`dev:seed`/`login.sh` are manifest- or DB-driven and need no prefix. Restate the prefix rule in every device-phase handoff; a `dev:restart` without it silently recomputes ports at the hash offset and breaks the stack's URL wiring.

### react-native-worklets 0.10.0 bundle mode crashes at runtime on RN 0.86 (SDK 57)

- Symptom: dev builds install fine but cold-launch redboxes on both platforms: `[runtime not ready]: RangeError: Maximum call stack size exceeded (native stack depth)` in recursive `metroRequire → get NativeModules`, then `Invariant Violation: "main" has not been registered`. Metro serves the bundle cleanly (HTTP 200, no SHA-1 errors) — the failure only appears when the JS executes on device.
- Cause: upstream incompatibility between worklets 0.10.0 bundle mode and RN 0.86 (verified by bisect: bundle mode off launches fine; `strictGlobal: false` variant crashes identically). Serve-side checks (expo export, headless bundle 200) do NOT catch it — only a device launch does.
- Fix: reverted bundle mode entirely (deleted babel.config.js, unwrapped getBundleModeMetroConfig, dropped the metro/metro-runtime 0.84.4 patches), kept `android.usePrecompiledHeaders` and the sentry `packageExtensions` metro fix. Do not re-enable bundle mode without an upstream worklets fix and a device launch check in the same round.

### R2 dev credentials dead (401 on every bucket op) — blocks attachment-upload E2E

- Symptom: presign (`cloudAgentNext.getAttachmentUploadUrl`) succeeds, but the PUT to the signed URL returns bare `401 Unauthorized`; direct S3 API calls (`HeadBucket`/`ListObjectsV2`) with the local `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` (root `.env.local`) 401 on every bucket.
- Cause: the R2 API token for account `e115e769…` stored in Vercel (development env) is invalid/revoked. Verified dead in: worktree `.env.local`, primary checkout `.env.local`, `vercel env pull` (development) — all identical by hash. Vercel production env has a different key id with an EMPTY secret (unusable). Wrangler OAuth (~/.wrangler) has no `r2` scope; `CLOUDFLARE_API_TOKEN` in `.env.local` is narrow-scoped (no R2, no memberships). No local path can mint R2 credentials — dashboard access required.
- Fix: a human must create a fresh R2 API token (Admin Read & Write, `cloud-agent-attachments-dev` bucket or account-wide) in the Kilo Code Cloudflare account and update Vercel development env + local `.env.local` files, then `pnpm dev:restart nextjs` (offset prefix if the worktree uses one). Afterwards re-run only the attachment E2E step (presign preflight → device attach). Check whether production attachments are also affected — the prod env's empty secret hints at a broader token rotation.
