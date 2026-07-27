# Workflow Learnings

Environment blockers and their fixes, recorded by the planner or orchestrator for the role that hit them. The full contract — when to read, when to write, entry shape, deduplication — is in [MOBILE_WORKFLOW.md](MOBILE_WORKFLOW.md).

## Planner

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
